import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";

import Organization from "../models/organization.js";
import Question from "../models/question.js";         // Question model (used throughout)
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";

const router = Router();

// fallback file loader
function fetchRandomQuestionsFromFile(count = 5) {
  try {
    const p = path.join(process.cwd(), "data", "data_questions.json");
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const all = JSON.parse(raw);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, count).map((d) => ({
      id: d.id || d._id || d.uuid || "fid-" + Math.random().toString(36).slice(2, 9),
      text: d.text,
      choices: (d.choices || []).map((c) => (typeof c === "string" ? { text: c } : { text: c.text || c })),
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
    console.error("[fetchRandomQuestionsFromFile] error:", err && (err.stack || err));
    return [];
  }
}

/**
 * GET /api/lms/quiz?count=5&module=responsibility&org=muono
 * create small ExamInstance that contains questionIds and (optionally) choicesOrder
 */
// GET /api/lms/quiz?count=5&module=responsibility&org=muono
// GET /api/lms/quiz?count=5&module=...&org=...  OR  /api/lms/quiz?examId=...
router.get("/quiz", async (req, res) => {
  try {
    const examIdParam = String(req.query.examId || "").trim();
    let count = parseInt(req.query.count || "5", 10);
    if (!Number.isFinite(count)) count = 5;
    count = Math.max(1, Math.min(50, count));

    const moduleName = String(req.query.module || "").trim();
    const orgSlug = String(req.query.org || "").trim();

    // helper to load file fallback
    function loadFileQuestionsMap() {
      const map = {};
      try {
        const p = path.join(process.cwd(), "data", "data_questions.json");
        if (!fs.existsSync(p)) return map;
        const arr = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const q of arr) {
          const id = String(q.id || q._id || q.uuid || "");
          if (id) map[id] = q;
        }
      } catch (e) {
        console.warn("[/api/lms/quiz] file fallback load failed:", e && e.message);
      }
      return map;
    }
    const fileQuestionsMap = loadFileQuestionsMap();

    // Normalize exam.questionIds that might be stored as array or JSON string
    function normalizeIds(raw) {
      if (raw === undefined || raw === null) return [];
      if (Array.isArray(raw)) return raw.map(String);
      if (typeof raw === "string") {
        const t = raw.trim();
        if (!t) return [];
        try {
          const parsed = JSON.parse(t);
          if (Array.isArray(parsed)) return parsed.map(String);
        } catch (e) {
          // fallback to split tokens / extract tokens
          // first capture parent:... tokens and 24-hex ids
          const tokens = [];
          const parentMatches = t.match(/parent:([0-9a-fA-F]{24})/g) || [];
          parentMatches.forEach(m => {
            const pid = m.split(':')[1].replace(/[^0-9a-fA-F]/g,'');
            if (pid) tokens.push(`parent:${pid}`);
          });
          const objMatches = t.match(/[0-9a-fA-F]{24}/g) || [];
          objMatches.forEach(m => tokens.push(m));
          // also add comma/space separated parts
          const parts = t.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
          for (const p of parts) if (!tokens.includes(p)) tokens.push(p);
          return tokens;
        }
      }
      return [String(raw)];
    }

    // If examId was supplied: return exact exam spec, expanding parents inline
    if (examIdParam) {
      try {
        const exam = await ExamInstance.findOne({ examId: examIdParam }).lean();
        if (!exam) return res.status(404).json({ error: "exam instance not found" });

        const rawList = normalizeIds(exam.questionIds || []);
        // We'll collect DB ids to fetch (parents + children + normal q ids)
        const dbIdSet = new Set();
        const parentTokens = []; // keep list of parent ids encountered in order

        // First pass: collect object ids we may need to fetch
        for (const token of rawList) {
          if (!token) continue;
          if (String(token).startsWith("parent:")) {
            const pid = String(token).split(":")[1] || "";
            parentTokens.push(pid);
            if (mongoose.isValidObjectId(pid)) dbIdSet.add(pid);
          } else if (mongoose.isValidObjectId(token)) {
            dbIdSet.add(token);
          } else {
            // non-ObjectId tokens map to fileQuestionsMap maybe
          }
        }

        // Fetch all referenced DB docs (parents and any direct question ids)
        let fetched = [];
        if (dbIdSet.size) {
          const objIds = Array.from(dbIdSet).map(id => mongoose.Types.ObjectId(id));
          fetched = await Question.find({ _id: { $in: objIds } }).lean().exec();
        }
        const byId = {};
        for (const d of fetched) byId[String(d._id)] = d;

        // For each parent, collect its child IDs and fetch children as needed
        const childIdSet = new Set();
        for (const pid of parentTokens) {
          const pdoc = byId[pid];
          if (pdoc && Array.isArray(pdoc.questionIds)) {
            for (const cid of pdoc.questionIds.map(String)) {
              if (cid) childIdSet.add(cid);
            }
          } else if (fileQuestionsMap[`parent:${pid}`]) {
            // unlikely, but keep for completeness
          }
        }

        // Fetch child docs if they look like ObjectIds
        const childObjIds = Array.from(childIdSet).filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id));
        if (childObjIds.length) {
          const childDocs = await Question.find({ _id: { $in: childObjIds } }).lean().exec();
          for (const c of childDocs) byId[String(c._id)] = c;
        }

        // Build the output series while preserving order and avoiding duplicates:
        const emittedChildIds = new Set(); // used to skip duplicates if child appears later in rawList
        const series = [];

        // helper to apply saved choicesOrder mapping for a question's choices
        function applyChoicesOrder(originalChoices, mapping) {
          // originalChoices: array of choice objects { text }
          // mapping: array where mapping[displayIndex] = originalIndex
          if (!Array.isArray(originalChoices)) return [];
          const norm = originalChoices.map(c => (typeof c === 'string' ? { text: c } : (c && c.text ? { text: c.text } : { text: String(c || '') })));
          if (!Array.isArray(mapping) || mapping.length === 0) return norm;
          if (mapping.length !== norm.length) return norm;
          const out = [];
          for (let i = 0; i < mapping.length; i++) {
            const idx = mapping[i];
            if (typeof idx === 'number' && typeof norm[idx] !== 'undefined') out.push(norm[idx]);
            else out.push({ text: '' });
          }
          return out;
        }

        for (const token of rawList) {
          if (!token) continue;

          // parent marker --> expand into a comprehension entry with ordered children
          if (String(token).startsWith("parent:")) {
            const pid = String(token).split(":")[1] || "";
            // prefer DB parent doc, otherwise try file fallback keyed by plain id
            const parentDoc = byId[pid] || fileQuestionsMap[pid] || null;
            if (!parentDoc) {
              // skip if missing
              continue;
            }

            // produce ordered children list (preserve parent's questionIds order)
            const orderedChildIds = Array.isArray(parentDoc.questionIds) ? parentDoc.questionIds.map(String) : [];
            const orderedChildren = [];
            for (const cid of orderedChildIds) {
              if (!cid) continue;
              // skip child if we've already emitted it (prevents duplicates)
              if (emittedChildIds.has(cid)) continue;

              // prefer DB doc if present
              if (byId[cid]) {
                const c = byId[cid];

                // build original choices
                const originalChoices = (c.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: ch.text || "" }));

                // find position of this question in the exam.questionIds to pick mapping
                let qPos = null;
                if (Array.isArray(exam.questionIds)) {
                  for (let ii = 0; ii < exam.questionIds.length; ii++) {
                    if (String(exam.questionIds[ii]) === String(cid)) { qPos = ii; break; }
                  }
                }
                const mapping = (Array.isArray(exam.choicesOrder) && qPos !== null) ? exam.choicesOrder[qPos] : null;
                const displayedChoices = applyChoicesOrder(originalChoices, mapping);

                orderedChildren.push({
                  id: String(c._id),
                  text: c.text,
                  choices: displayedChoices,
                  tags: c.tags || [],
                  difficulty: c.difficulty || "medium"
                });
                emittedChildIds.add(cid);
                continue;
              }

              // fallback to file map
              if (fileQuestionsMap[cid]) {
                const fq = fileQuestionsMap[cid];
                orderedChildren.push({
                  id: cid,
                  text: fq.text,
                  choices: (fq.choices || []).map(ch => (typeof ch === "string" ? { text: ch } : { text: ch.text || "" })),
                  tags: fq.tags || [],
                  difficulty: fq.difficulty || "medium"
                });
                emittedChildIds.add(cid);
                continue;
              }

              // If child missing, skip gracefully
            }

            series.push({
              id: String(parentDoc._id || parentDoc.id || pid),
              type: "comprehension",
              passage: parentDoc.passage || parentDoc.text || "",
              children: orderedChildren,
              tags: parentDoc.tags || [],
              difficulty: parentDoc.difficulty || "medium"
            });

            continue;
          }

          // Normal question token (DB id or file id)
          // If token corresponds to a child that was already emitted as part of a parent, skip it
          if (emittedChildIds.has(String(token))) {
            // skip duplicate child
            continue;
          }

          if (mongoose.isValidObjectId(token)) {
            const qdoc = byId[token];
            if (!qdoc) {
              // question missing from DB (skip)
              continue;
            }

            // build original choices
            const originalChoices = (qdoc.choices || []).map(c => (typeof c === "string" ? { text: c } : { text: c.text || '' }));

            // find q position in exam.questionIds
            let qPos = null;
            if (Array.isArray(exam.questionIds)) {
              for (let ii = 0; ii < exam.questionIds.length; ii++) {
                if (String(exam.questionIds[ii]) === String(token)) { qPos = ii; break; }
              }
            }
            const mapping = (Array.isArray(exam.choicesOrder) && qPos !== null) ? exam.choicesOrder[qPos] : null;
            const displayedChoices = applyChoicesOrder(originalChoices, mapping);

            series.push({
              id: String(qdoc._id),
              text: qdoc.text,
              choices: displayedChoices,
              tags: qdoc.tags || [],
              difficulty: qdoc.difficulty || 'medium'
            });
            continue;
          }

          // Non-object token -> file fallback
          if (fileQuestionsMap[token]) {
            const fq = fileQuestionsMap[token];
            // ensure not duplicate
            if (emittedChildIds.has(token)) continue;
            series.push({
              id: token,
              text: fq.text,
              choices: (fq.choices || []).map(c => (typeof c === "string" ? { text: c } : { text: c.text || '' })),
              tags: fq.tags || [],
              difficulty: fq.difficulty || 'medium'
            });
            emittedChildIds.add(token);
            continue;
          }

          // unknown token -> skip
        }

        return res.json({ examId: exam.examId, series });
      } catch (e) {
        console.error("[/api/lms/quiz] exam load error:", e && (e.stack || e));
        return res.status(500).json({ error: "failed to load exam instance" });
      }
    } // end examId branch

    // ----- Sampling branch (no examId) -----
    try {
      // org filter
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
      pipeline.push({ $sample: { size: Math.max(1, Math.min(50, count)) } });

      let docs = [];
      try {
        docs = await Question.aggregate(pipeline).allowDiskUse(true);
      } catch (e) {
        console.error("[/api/lms/quiz] aggregate error (sampling):", e && (e.stack || e));
      }

      if (!docs || !docs.length) {
        // fallback to file questions
        const fallback = fetchRandomQuestionsFromFile(count);
        const series = fallback.map(d => ({ id: d.id, text: d.text, choices: d.choices, tags: d.tags, difficulty: d.difficulty }));
        return res.json({ examId: null, series });
      }

      // For sampling we will attempt to include children for any comprehension found,
      // but we do not expand parent markers because sampling returns question docs directly.
      const outSeries = [];
      for (const d of docs) {
        const isComp = (d && d.type === "comprehension");
        if (isComp) {
          // try to fetch children (best effort) and preserve order
          let children = [];
          try {
            const cids = Array.isArray(d.questionIds) ? d.questionIds.map(String) : [];
            if (cids.length) {
              const objIds = cids.filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id));
              if (objIds.length) {
                const cs = await Question.find({ _id: { $in: objIds } }).lean().exec();
                children = cids.map(cid => {
                  const f = cs.find(x => String(x._id) === String(cid));
                  if (!f) return null;
                  return {
                    id: String(f._id),
                    text: f.text,
                    choices: (f.choices || []).map(ch => (typeof ch === 'string' ? { text: ch } : { text: ch.text || '' })),
                    tags: f.tags || [],
                    difficulty: f.difficulty || 'medium'
                  };
                }).filter(Boolean);
              }
            }
          } catch (e) {
            console.warn("[/api/lms/quiz] failed to load children for sampled parent:", d._id, e && e.message);
          }

          outSeries.push({ id: String(d._id), type: "comprehension", passage: d.passage || d.text || "", children, tags: d.tags || [], difficulty: d.difficulty || 'medium' });
        } else {
          outSeries.push({
            id: String(d._id),
            text: d.text,
            choices: (d.choices || []).map(c => (typeof c === 'string' ? { text: c } : { text: c.text || '' })),
            tags: d.tags || [],
            difficulty: d.difficulty || 'medium'
          });
        }
      }

      return res.json({ examId: null, series: outSeries });
    } catch (e) {
      console.error("[/api/lms/quiz] sampling error:", e && (e.stack || e));
      return res.status(500).json({ error: "failed to sample questions" });
    }
  } catch (err) {
    console.error("[GET /api/lms/quiz] unexpected error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch quiz" });
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
    if (!answers.length) return res.status(400).json({ error: "No answers submitted" });

    const examId = String(payload.examId || "").trim() || null;
    const moduleKey = String(payload.module || "").trim() || null;
    const orgSlugOrId = payload.org || null;

    // map of question ids supplied
    const qIds = answers.map(a => a.questionId).filter(Boolean).map(String);

    // try to load ExamInstance (may be null)
    let exam = null;
    if (examId) {
      try {
        exam = await ExamInstance.findOne({ examId }).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] exam lookup error:", e && (e.stack || e));
      }
    }

    // load DB questions for any ObjectId-like ids (use Question model)
    const byId = {};
    const dbIds = qIds.filter(id => mongoose.isValidObjectId(id));
    if (dbIds.length) {
      try {
        const qDocs = await Question.find({ _id: { $in: dbIds } }).lean().exec();
        for (const q of qDocs) byId[String(q._id)] = q;
      } catch (e) {
        console.error("[quiz/submit] DB lookup error:", e && (e.stack || e));
      }
    }

    // file fallback: include file questions by id (for fid-... items)
    try {
      const p = path.join(process.cwd(), "data", "data_questions.json");
      if (fs.existsSync(p)) {
        const fileQ = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const fq of fileQ) {
          const fid = String(fq.id || fq._id || fq.uuid || "");
          if (fid && !byId[fid]) byId[fid] = fq;
        }
      }
    } catch (e) {
      console.error("[quiz/submit] file fallback error:", e && (e.stack || e));
    }

    // Build a quick lookup for exam question order & choicesOrder if exam exists
    const examIndexMap = {}; // questionId -> index in exam.questionIds
    const examChoicesOrder = Array.isArray(exam && exam.choicesOrder) ? exam.choicesOrder : [];

    if (exam && Array.isArray(exam.questionIds)) {
      for (let i = 0; i < exam.questionIds.length; i++) {
        const qidStr = String(exam.questionIds[i]);
        examIndexMap[qidStr] = i;
      }
    }

    // Scoring & saved answers
    let score = 0;
    const details = [];
    const savedAnswers = [];

    for (const a of answers) {
      const qid = String(a.questionId || "");
      const shownIndex = (typeof a.choiceIndex === "number") ? a.choiceIndex : null;

      let canonicalIndex = (typeof shownIndex === "number") ? shownIndex : null;

      if (exam && examIndexMap.hasOwnProperty(qid)) {
        const qPos = examIndexMap[qid];
        const mapping = Array.isArray(examChoicesOrder[qPos]) ? examChoicesOrder[qPos] : null;
        if (mapping && typeof shownIndex === "number") {
          const mapped = mapping[shownIndex];
          if (typeof mapped === "number") canonicalIndex = mapped;
        }
      }

      const qdoc = byId[qid] || null;

      let correctIndex = null;
      if (qdoc) {
        if (typeof qdoc.correctIndex === "number") correctIndex = qdoc.correctIndex;
        else if (typeof qdoc.answerIndex === "number") correctIndex = qdoc.answerIndex;
        else if (typeof qdoc.correct === "number") correctIndex = qdoc.correct;
      }

      let selectedText = "";
      if (qdoc) {
        const choices = qdoc.choices || [];
        const tryChoice = (idx) => {
          if (idx === null || idx === undefined) return "";
          const c = choices[idx];
          if (!c) return "";
          return (typeof c === "string") ? c : (c.text || "");
        };
        selectedText = tryChoice(canonicalIndex);
      }

      const correct = (correctIndex !== null && canonicalIndex !== null && correctIndex === canonicalIndex);
      if (correct) score++;

      details.push({
        questionId: qid,
        correctIndex: (correctIndex !== null) ? correctIndex : null,
        yourIndex: canonicalIndex,
        correct: !!correct
      });

      const qObjId = mongoose.isValidObjectId(qid) ? mongoose.Types.ObjectId(qid) : qid;
      savedAnswers.push({
        questionId: qObjId,
        choiceIndex: (typeof canonicalIndex === "number") ? canonicalIndex : null,
        shownIndex: (typeof shownIndex === "number") ? shownIndex : null,
        selectedText,
        correctIndex: (typeof correctIndex === "number") ? correctIndex : null,
        correct: !!correct
      });
    }

    const total = answers.length;
    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = parseInt(process.env.QUIZ_PASS_THRESHOLD || "60", 10);
    const passed = percentage >= passThreshold;

    // Find / update or create Attempt
    let attemptFilter = {};
    if (examId) attemptFilter.examId = examId;
    else {
      attemptFilter = {
        userId: (req.user && req.user._id) ? req.user._id : undefined,
        organization: (exam && exam.org) ? exam.org : undefined,
        module: exam ? exam.module : (moduleKey || undefined)
      };
    }
    Object.keys(attemptFilter).forEach(k => attemptFilter[k] === undefined && delete attemptFilter[k]);

    let attempt = null;
    try {
      if (Object.keys(attemptFilter).length) {
        attempt = await Attempt.findOne(attemptFilter).sort({ createdAt: -1 }).exec();
      }
    } catch (e) {
      console.error("[quiz/submit] attempt lookup error:", e && (e.stack || e));
    }

    const now = new Date();
    const attemptDoc = {
      examId: examId || ("exam-" + Date.now().toString(36)),
      userId: (req.user && req.user._id) ? req.user._id : (exam && exam.user) ? exam.user : null,
      organization: (exam && exam.org) ? exam.org : (typeof orgSlugOrId === 'string' ? orgSlugOrId : null),
      module: (exam && exam.module) ? exam.module : (moduleKey || null),
      questionIds: (exam && Array.isArray(exam.questionIds)) ? exam.questionIds : qIds.map(id => (mongoose.isValidObjectId(id) ? mongoose.Types.ObjectId(id) : id)),
      answers: savedAnswers,
      score,
      maxScore: total,
      passed: !!passed,
      status: "finished",
      startedAt: (exam && exam.createdAt) ? exam.createdAt : now,
      finishedAt: now,
      updatedAt: now,
      createdAt: attempt ? attempt.createdAt : now
    };

    let savedAttempt = null;
    if (attempt) {
      try {
        await Attempt.updateOne({ _id: attempt._id }, { $set: attemptDoc }).exec();
        savedAttempt = await Attempt.findById(attempt._id).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] attempt update failed:", e && (e.stack || e));
      }
    } else {
      try {
        const newA = await Attempt.create(attemptDoc);
        savedAttempt = await Attempt.findById(newA._id).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] attempt create failed:", e && (e.stack || e));
      }
    }

    // mark exam instance as used (optional)
    if (exam) {
      try {
        await ExamInstance.updateOne({ examId: exam.examId }, { $set: { updatedAt: now, expiresAt: now } }).exec();
      } catch (e) {
        console.error("[quiz/submit] failed to update examInstance:", e && (e.stack || e));
      }
    }

    return res.json({
      examId: attemptDoc.examId,
      total,
      score,
      percentage,
      passThreshold,
      passed,
      details,
      debug: {
        examFound: !!exam,
        attemptSaved: !!savedAttempt
      }
    });
  } catch (err) {
    console.error("[POST /api/lms/quiz/submit] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to score quiz", detail: String(err && err.message) });
  }
});

export default router;
