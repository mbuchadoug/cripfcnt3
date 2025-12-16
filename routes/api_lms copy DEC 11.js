// --- put these imports at the top of the file (replace any old ones) ---
import { Router } from "express";
import mongoose from "mongoose";
import Organization from "../models/organization.js";
import Question from "../models/question.js";         // the Question model (was referenced as QuizQuestion)
import ExamInstance from "../models/examInstance.js";
const router = Router();
// ----------------------------------------------------------------------


// helper: sample N random docs using Mongo's aggregation if available
async function fetchRandomQuestionsFromDB(count = 5, opts = {}) {
  const { moduleName = "", orgSlug = "" } = opts;

  try {
    const match = {};

    // module filter (case-insensitive) e.g. "responsibility"
    if (moduleName) {
      match.module = { $regex: new RegExp(`^${moduleName}$`, "i") };
    }

    // org filter
    if (orgSlug) {
      // ORG quiz -> org-specific OR global
      const org = await Organization.findOne({ slug: orgSlug }).lean();
      if (org) {
        match.$or = [
          { organization: org._id },
          { organization: null },
          { organization: { $exists: false } },
        ];
      }
    } else {
      // DEMO quiz (no org param) -> ONLY global questions
      match.$or = [
        { organization: null },
        { organization: { $exists: false } },
      ];
    }

    const pipeline = [];
    if (Object.keys(match).length) pipeline.push({ $match: match });
    pipeline.push({ $sample: { size: Number(count) } });

    const docs = await Question.aggregate(pipeline).allowDiskUse(true);

    return docs.map((d) => ({
      id: String(d._id),
      text: d.text,
      // choices in DB can be [{ text }] or ["A", "B", ...]
      choices: (d.choices || []).map((c) =>
        typeof c === "string" ? { text: c } : { text: c.text }
      ),
      // may be correctIndex or answerIndex – we only need this for scoring
      correctIndex:
        typeof d.correctIndex === "number"
          ? d.correctIndex
          : typeof d.answerIndex === "number"
          ? d.answerIndex
          : null,
      tags: d.tags || [],
      difficulty: d.difficulty || "medium",
    }));
  } catch (err) {
    console.error(
      "[fetchRandomQuestionsFromDB] error:",
      err && (err.stack || err)
    );
    return null;
  }
}

// fallback: load static file data/data_questions.json if DB missing (dev only)
function fetchRandomQuestionsFromFile(count = 5) {
  try {
    const p = path.join(process.cwd(), "data", "data_questions.json");
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const all = JSON.parse(raw);

    // shuffle
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }

    return all.slice(0, count).map((d) => ({
      id: d.id || d._id || d.uuid || "fid-" + Math.random().toString(36).slice(2, 9),
      text: d.text,
      choices: (d.choices || []).map((c) =>
        typeof c === "string" ? { text: c } : { text: c.text || c }
      ),
      correctIndex:
        typeof d.correctIndex === "number"
          ? d.correctIndex
          : typeof d.answerIndex === "number"
          ? d.answerIndex
          : null,
      tags: d.tags || [],
      difficulty: d.difficulty || "medium",
    }));
  } catch (err) {
    console.error(
      "[fetchRandomQuestionsFromFile] error:",
      err && (err.stack || err)
    );
    return [];
  }
}

/**
 * GET /api/lms/quiz?count=5&module=Responsibility&org=muono
 * Returns: { examId, series: [...] }
 */
// Replace existing GET /quiz handler with this in routes/api_lms.js (or routes/lms_api.js)
router.get("/quiz", async (req, res) => {
  try {
    // prefer explicit examId (assigned quizzes)
    const examId = String(req.query.examId || "").trim() || null;

    // fallback sampling params
    let rawCount = parseInt(req.query.count || "5", 10);
    if (!Number.isFinite(rawCount)) rawCount = 5;
    const count = Math.max(1, Math.min(50, rawCount));

    const moduleName = String(req.query.module || "").trim(); // e.g. "Responsibility"
    const orgSlug = String(req.query.org || "").trim();       // e.g. "muono"

    // models assumed imported at top of file:
    // import ExamInstance from "../models/examInstance.js";
    // import Question from "../models/question.js";
    // import Organization from "../models/organization.js";

    // If examId was provided -> return that exact exam + question docs (preserve order)
    if (examId) {
      console.log("[/api/lms/quiz] loading examId:", examId);
      try {
        const exam = await ExamInstance.findOne({ examId }).lean().exec();
        if (!exam) {
          console.warn("[/api/lms/quiz] examId not found:", examId);
          return res.status(404).json({ error: "exam not found" });
        }

        // Ensure questionIds array exists
        const qIds = Array.isArray(exam.questionIds) ? exam.questionIds.map(String) : [];

        // Load question docs from DB (these may include comprehension parents and/or child questions)
        const dbDocs = qIds.length
          ? await Question.find({ _id: { $in: qIds } }).lean().exec()
          : [];

        // Also load any parent comprehension docs referenced by these ids (in case parent IDs were used)
        // We'll build a map by _id for quick lookup
        const byId = {};
        for (const d of dbDocs) byId[String(d._id)] = d;

        // For completeness: if exam.questionIds includes some ids that are comprehension parent ids,
        // and those parents have questionIds (children), we should load those children and return parent with children.
        // Also if some docs returned are parents, fetch their children.
        const parentIdsToFetchChildren = [];
        for (const id of qIds) {
          const doc = byId[id];
          if (doc && (doc.type === "comprehension" || (doc.passage && Array.isArray(doc.questionIds) && doc.questionIds.length))) {
            parentIdsToFetchChildren.push(id);
          }
        }

        // collect child ids to fetch
        const childIdsSet = new Set();
        for (const pid of parentIdsToFetchChildren) {
          const parentDoc = byId[pid];
          const children = Array.isArray(parentDoc.questionIds) ? parentDoc.questionIds.map(String) : [];
          children.forEach(c => childIdsSet.add(c));
        }

        let childDocs = [];
        if (childIdsSet.size) {
          const childIds = Array.from(childIdsSet);
          childDocs = await Question.find({ _id: { $in: childIds } }).lean().exec();
          for (const c of childDocs) byId[String(c._id)] = c;
        }

        // Build series to return in the same order as exam.questionIds
        const series = [];
        for (const qid of qIds) {
          const doc = byId[qid];
          if (!doc) {
            // doc missing (maybe it was a file-fallback item) — skip or include placeholder
            continue;
          }

          // If this doc is a comprehension parent, include its passage + children (full objects)
          const isParent = doc.type === "comprehension" || (doc.passage && Array.isArray(doc.questionIds) && doc.questionIds.length);
          if (isParent) {
            const childIds = (doc.questionIds || []).map(String).filter(Boolean);
            const children = childIds.map(id => {
              const c = byId[id];
              if (!c) return null;
              // normalize choices shape for client
              const choices = (c.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: (ch.text || ch) }));
              return {
                id: String(c._id),
                text: c.text,
                choices,
                tags: c.tags || [],
                difficulty: c.difficulty || "medium"
              };
            }).filter(Boolean);

            series.push({
              id: String(doc._id),
              type: "comprehension",
              passage: doc.passage || doc.text || "",
              children,
              tags: doc.tags || [],
              difficulty: doc.difficulty || "medium"
            });
          } else {
            // normal question
            const choices = (doc.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: (ch.text || ch) }));
            series.push({
              id: String(doc._id),
              text: doc.text,
              choices,
              tags: doc.tags || [],
              difficulty: doc.difficulty || "medium"
            });
          }
        }

        return res.json({ examId: exam.examId, series });
      } catch (err) {
        console.error("[/api/lms/quiz] exam load error:", err && (err.stack || err));
        return res.status(500).json({ error: "failed to load exam", detail: String(err && err.message) });
      }
    }

    // ---------- No examId: sampling mode (old behavior) ----------
    try {
      // build module + org match
      const match = {};
      if (moduleName) match.module = { $regex: new RegExp(`^${moduleName}$`, "i") };

      if (orgSlug) {
        const org = await Organization.findOne({ slug: orgSlug }).lean();
        if (org) {
          match.$or = [{ organization: org._id }, { organization: null }, { organization: { $exists: false } }];
        } else {
          // org requested but not found -> default to global only
          match.$or = [{ organization: null }, { organization: { $exists: false } }];
        }
      } else {
        // demo — global only
        match.$or = [{ organization: null }, { organization: { $exists: false } }];
      }

      const pipeline = [];
      if (Object.keys(match).length) pipeline.push({ $match: match });
      pipeline.push({ $sample: { size: Number(count) } });

      const docs = await Question.aggregate(pipeline).allowDiskUse(true);

      // Map docs into series (handle comprehension parent detection as in other code)
      const series = [];
      for (const d of docs) {
        const isComprehension = d.type === "comprehension" || (d.passage && Array.isArray(d.questionIds) && d.questionIds.length);
        if (isComprehension) {
          // fetch children
          let children = [];
          try {
            const ids = (d.questionIds || []).filter(Boolean).map(String).filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id));
            if (ids.length) {
              const cs = await Question.find({ _id: { $in: ids } }).lean().exec();
              children = cs.map(c => ({
                id: String(c._id),
                text: c.text,
                choices: (c.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: (ch.text || ch) })),
                tags: c.tags || [],
                difficulty: c.difficulty || "medium"
              }));
            }
          } catch (e) {
            console.warn("[/api/lms/quiz] failed to load children for parent:", d._id, e && e.message);
          }

          series.push({
            id: String(d._id),
            type: "comprehension",
            passage: d.passage || d.text || "",
            children,
            tags: d.tags || [],
            difficulty: d.difficulty || "medium"
          });
        } else {
          series.push({
            id: String(d._id),
            text: d.text,
            choices: (d.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: (ch.text || ch) })),
            tags: d.tags || [],
            difficulty: d.difficulty || "medium"
          });
        }
      }

      // If sampling produced fewer than requested, still return what we have
      const examIdOut = "exam-" + Date.now().toString(36);
      return res.json({ examId: examIdOut, series });
    } catch (err) {
      console.error("[/api/lms/quiz] sampling error:", err && (err.stack || err));
      return res.status(500).json({ error: "failed to sample questions", detail: String(err && err.message) });
    }
  } catch (err) {
    console.error("[/api/lms/quiz] unexpected error:", err && (err.stack || err));
    return res.status(500).json({ error: "unexpected error", detail: String(err && err.message) });
  }
});

/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [{ questionId, choiceIndex }] }
 */
router.post("/quiz/submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    if (!answers.length)
      return res.status(400).json({ error: "No answers submitted" });

    const qIds = answers
      .map((a) => a.questionId)
      .filter(Boolean)
      .map(String);

    const docs = await Question.find({ _id: { $in: qIds } }).lean().exec();
    const byId = {};
    for (const q of docs) byId[String(q._id)] = q;

    let score = 0;
    const total = answers.length;
    const details = [];

    for (const a of answers) {
      const q = byId[String(a.questionId)];
      const yourIndex =
        typeof a.choiceIndex === "number" ? a.choiceIndex : null;

      let correctIndex = null;
      if (q) {
        if (typeof q.correctIndex === "number") correctIndex = q.correctIndex;
        else if (typeof q.answerIndex === "number") correctIndex = q.answerIndex;
        else if (typeof q.correct === "number") correctIndex = q.correct;
      }

      const correct =
        correctIndex !== null &&
        yourIndex !== null &&
        correctIndex === yourIndex;

      if (correct) score++;

      details.push({
        questionId: a.questionId,
        correctIndex,
        yourIndex,
        correct: !!correct,
      });
    }

    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = parseInt(
      process.env.QUIZ_PASS_THRESHOLD || "60",
      10
    );
    const passed = percentage >= passThreshold;

    return res.json({
      examId: payload.examId || "exam-" + Date.now().toString(36),
      total,
      score,
      percentage,
      passThreshold,
      passed,
      details,
    });
  } catch (err) {
    console.error(
      "[POST /api/lms/quiz/submit] error:",
      err && (err.stack || err)
    );
    return res.status(500).json({ error: "Failed to score quiz" });
  }
});

export default router;
