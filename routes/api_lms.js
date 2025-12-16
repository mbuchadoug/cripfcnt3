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
// Replace your existing router.get("/quiz", ...) in routes/api_lms.js with this function
router.get("/quiz", async (req, res) => {
  try {
    // accept examId in several query forms just to be robust
    const examIdParam = String(req.query.examId || req.query.exam_id || req.query.id || "").trim() || null;

    // sampling defaults
    let rawCount = parseInt(req.query.count || "5", 10);
    if (!Number.isFinite(rawCount)) rawCount = 5;
    const count = Math.max(1, Math.min(50, rawCount));

    const moduleName = String(req.query.module || "").trim(); // optional filter
    const orgSlug = String(req.query.org || "").trim();      // optional org

    // helper: load file fallback map (if you use file fallback ids)
    const fileQuestionsMap = {};
    try {
      const p = path.join(process.cwd(), "data", "data_questions.json");
      if (fs.existsSync(p)) {
        const arr = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const fq of arr) {
          const fid = String(fq.id || fq._id || fq.uuid || "");
          if (fid) fileQuestionsMap[fid] = fq;
        }
      }
    } catch (e) {
      console.warn("[/api/lms/quiz] file fallback load failed:", e && e.message);
    }

    // Normalize exam.questionIds that might be stored as array, stringified JSON, etc.
    function normalizeExamQuestionIds(raw) {
      if (raw === undefined || raw === null) return [];
      if (Array.isArray(raw)) return raw.map(String);
      if (typeof raw === "string") {
        const t = raw.trim();
        if (!t) return [];
        try {
          const parsed = JSON.parse(t);
          if (Array.isArray(parsed)) return parsed.map(String);
        } catch (e) {
          // not JSON — try to split by commas/spaces while preserving parent: markers and 24-hex ids
          // fallback: extract parent:... tokens and 24-hex object ids and any fid-... tokens
          const items = [];
          // parent:... tokens
          const parentMatches = t.match(/parent:([0-9a-fA-F]{24})/g) || [];
          parentMatches.forEach(m => {
            const pid = m.split(':')[1].replace(/[^0-9a-fA-F]/g,'');
            if (pid) items.push(`parent:${pid}`);
          });
          // 24-hex object ids
          const objMatches = t.match(/[0-9a-fA-F]{24}/g) || [];
          objMatches.forEach(m => items.push(String(m)));
          // fid-* or other non-object tokens (split on commas)
          const commaParts = t.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
          for (const p of commaParts) {
            if (!items.includes(p)) items.push(p);
          }
          return items;
        }
      }
      // fallback
      return [String(raw)];
    }

    // ------------------ If examId was supplied -> return exact exam ordering ------------------
    if (examIdParam) {
      console.log("[/api/lms/quiz] loading examId:", examIdParam);
      try {
        const exam = await ExamInstance.findOne({ examId: examIdParam }).lean();
        if (!exam) {
          console.warn("[/api/lms/quiz] exam not found:", examIdParam);
          return res.status(404).json({ error: "exam not found" });
        }

        const rawQIds = normalizeExamQuestionIds(exam.questionIds || []);
        // preserve original order; we'll expand parent:... entries inline
        const qIds = rawQIds.map(String).filter(Boolean);

        // Collect DB ids we should fetch: any plain ObjectId-like tokens and any parents that are ObjectId-like
        const objectIdStrings = new Set();
        const parentMarkers = [];

        for (const id of qIds) {
          if (typeof id === "string" && id.startsWith("parent:")) {
            const pid = id.split(":")[1] || "";
            parentMarkers.push(pid);
            if (mongoose.isValidObjectId(pid)) objectIdStrings.add(pid);
          } else if (mongoose.isValidObjectId(id)) {
            objectIdStrings.add(id);
          }
        }

        // Fetch all referenced DB docs (parents + any direct ids)
        let fetchedDocs = [];
        if (objectIdStrings.size) {
          const objIds = Array.from(objectIdStrings).map(id => mongoose.Types.ObjectId(id));
          fetchedDocs = await Question.find({ _id: { $in: objIds } }).lean().exec();
        }
        const byId = {};
        for (const d of fetchedDocs) byId[String(d._id)] = d;

        // For each parent we fetched, collect child ids (and also for parents not fetched, attempt best-effort fetch)
        const childIdSet = new Set();
        for (const pid of parentMarkers) {
          const pdoc = byId[pid];
          if (pdoc && Array.isArray(pdoc.questionIds)) {
            for (const cid of pdoc.questionIds.map(String)) {
              if (cid) childIdSet.add(cid);
            }
          }
        }

        // If childIdSet contains DB ids, fetch them too
        const childObjIds = Array.from(childIdSet).filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id));
        if (childObjIds.length) {
          const childDocs = await Question.find({ _id: { $in: childObjIds } }).lean().exec();
          for (const c of childDocs) byId[String(c._id)] = c;
        }

        // Build output series preserving exact exam order:
        const series = [];
        for (const token of qIds) {
          if (!token) continue;
          if (String(token).startsWith("parent:")) {
            const pid = String(token).split(":")[1] || "";
            const parentDoc = byId[pid];
            if (!parentDoc) {
              console.warn("[/api/lms/quiz] parent marker present but parent doc missing:", pid);
              continue; // skip missing parent
            }
            // preserve children ordering as stored on parent.questionIds
            const orderedChildIds = Array.isArray(parentDoc.questionIds) ? parentDoc.questionIds.map(String) : [];
            const orderedChildren = orderedChildIds.map(cid => {
              // prefer DB doc
              if (byId[cid]) {
                const c = byId[cid];
                return {
                  id: String(c._id),
                  text: c.text,
                  choices: (c.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: (ch.text || "") })),
                  tags: c.tags || [],
                  difficulty: c.difficulty || "medium"
                };
              }
              // fallback to fileQuestions map (if you used file ids)
              if (fileQuestionsMap[cid]) {
                const fq = fileQuestionsMap[cid];
                return {
                  id: cid,
                  text: fq.text,
                  choices: (fq.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: (ch.text || "") })),
                  tags: fq.tags || [],
                  difficulty: fq.difficulty || "medium"
                };
              }
              console.warn("[/api/lms/quiz] child missing for parent", pid, "childId:", cid);
              return null;
            }).filter(Boolean);

            series.push({
              id: String(parentDoc._id),
              type: "comprehension",
              passage: parentDoc.passage || parentDoc.text || "",
              children: orderedChildren,
              tags: parentDoc.tags || [],
              difficulty: parentDoc.difficulty || "medium"
            });
            continue;
          }

          // normal single question token (DB id or file id)
          if (mongoose.isValidObjectId(token)) {
            const qdoc = byId[token];
            if (!qdoc) {
              console.warn("[/api/lms/quiz] DB question id missing:", token);
              continue;
            }
            series.push({
              id: String(qdoc._id),
              text: qdoc.text,
              choices: (qdoc.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: (ch.text || "") })),
              tags: qdoc.tags || [],
              difficulty: qdoc.difficulty || "medium"
            });
            continue;
          }

          // non-ObjectId token -> try file fallback
          if (fileQuestionsMap[token]) {
            const fq = fileQuestionsMap[token];
            series.push({
              id: token,
              text: fq.text,
              choices: (fq.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: (ch.text || "") })),
              tags: fq.tags || [],
              difficulty: fq.difficulty || "medium"
            });
            continue;
          }

          console.warn("[/api/lms/quiz] unknown token (skipping):", token);
        } // end for tokens

        // return exactly what the exam specifies (do NOT sample/pad)
        return res.json({ examId: exam.examId, series });
      } catch (e) {
        console.error("[/api/lms/quiz] exam load error:", e && (e.stack || e));
        return res.status(500).json({ error: "failed to load exam", detail: String(e && e.message) });
      }
    } // end examId branch

    // ------------------ No examId -> sampling mode (module+org aware) ------------------
    try {
      const match = {};
      if (moduleName) match.module = { $regex: new RegExp(`^${moduleName}$`, "i") };

      if (orgSlug) {
        const org = await Organization.findOne({ slug: orgSlug }).lean();
        if (org) match.$or = [{ organization: org._id }, { organization: null }, { organization: { $exists: false } }];
        else match.$or = [{ organization: null }, { organization: { $exists: false } }];
      } else {
        match.$or = [{ organization: null }, { organization: { $exists: false } }];
      }

      const pipeline = [];
      if (Object.keys(match).length) pipeline.push({ $match: match });
      pipeline.push({ $sample: { size: Number(count) } });

      const docs = await Question.aggregate(pipeline).allowDiskUse(true);
      if (!docs || !docs.length) {
        // fallback to file questions
        const fallback = fetchRandomQuestionsFromFile(count);
        const series = fallback.map(d => ({ id: d.id, text: d.text, choices: d.choices, tags: d.tags, difficulty: d.difficulty }));
        return res.json({ examId: null, series });
      }

      // sampling: return parents as parent objects but children may be empty (cheap)
      const series = [];
      for (const d of docs) {
        const isComprehension = d.type === "comprehension" || (d.passage && Array.isArray(d.questionIds) && d.questionIds.length);
        if (isComprehension) {
          // try best-effort to fetch children for sampled parent
          let children = [];
          try {
            const ids = (d.questionIds || []).filter(Boolean).map(String).filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id));
            if (ids.length) {
              const cs = await Question.find({ _id: { $in: ids } }).lean().exec();
              children = ids.map(idStr => {
                const found = cs.find(x => String(x._id) === String(idStr));
                if (!found) return null;
                return {
                  id: String(found._id),
                  text: found.text,
                  choices: (found.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: (ch.text || "") })),
                  tags: found.tags || [],
                  difficulty: found.difficulty || "medium"
                };
              }).filter(Boolean);
            }
          } catch (e) {
            console.warn("[/api/lms/quiz] failed to load children for parent:", d._id, e && e.message);
          }

          series.push({ id: String(d._id), type: "comprehension", passage: d.passage || d.text || "", children, tags: d.tags || [], difficulty: d.difficulty || "medium" });
        } else {
          series.push({ id: String(d._id), text: d.text, choices: (d.choices || []).map(c => (typeof c === "string" ? { text: c } : { text: (c.text || c) })), tags: d.tags || [], difficulty: d.difficulty || "medium" });
        }
      }

      const examIdOut = "exam-" + Date.now().toString(36);
      return res.json({ examId: examIdOut, series });
    } catch (e) {
      console.error("[/api/lms/quiz] sampling error:", e && (e.stack || e));
      return res.status(500).json({ error: "failed to sample questions", detail: String(e && e.message) });
    }
  } catch (err) {
    console.error("[GET /api/lms/quiz] unexpected error:", err && (err.stack || err));
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
