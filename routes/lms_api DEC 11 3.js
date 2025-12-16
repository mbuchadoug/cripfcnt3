// routes/lms_api.js
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
router.get("/quiz", async (req, res) => {
  try {
    // primary keys
    const examIdParam = String(req.query.examId || "").trim();
    let count = parseInt(req.query.count || "5", 10);
    if (!Number.isFinite(count)) count = 5;
    count = Math.max(1, Math.min(50, count));

    const moduleName = String(req.query.module || "").trim(); // optional
    const orgSlug = String(req.query.org || "").trim();      // optional

    // If client asked for a specific exam instance, return it exactly
    if (examIdParam) {
      try {
        const ex = await ExamInstance.findOne({ examId: examIdParam }).lean();
        if (!ex) return res.status(404).json({ error: "exam instance not found" });

        // load docs for each questionId in exam.questionIds
        const qIds = Array.isArray(ex.questionIds) ? ex.questionIds.map(String) : [];
        const objIds = qIds.filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id));
        let docs = [];
        if (objIds.length) {
          docs = await Question.find({ _id: { $in: objIds } }).lean();
        }
        // map by id so we preserve order
        const byId = {};
        for (const d of docs) byId[String(d._id)] = d;

        const series = [];
        // Walk the exam.questionIds in order and push either question or comprehension parent with children
        for (const qid of qIds) {
          const d = byId[qid];
          if (!d) {
            // If a missing question (maybe non-ObjectId fallback) skip
            continue;
          }

          const isComprehension = (d.type === "comprehension") || (d.passage && Array.isArray(d.questionIds) && d.questionIds.length > 0);

          if (isComprehension) {
            // load children by IDs
            const childIds = Array.isArray(d.questionIds) ? d.questionIds.map(String) : [];
            const childObjIds = childIds.filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id));
            let children = [];
            if (childObjIds.length) {
              children = await Question.find({ _id: { $in: childObjIds } }).lean();
            }
            // return parent with children full objects
            series.push({
              id: String(d._id),
              type: "comprehension",
              passage: d.passage || "",
              children: (children || []).map(c => ({
                id: String(c._id),
                text: c.text,
                choices: (c.choices || []).map(ch => (typeof ch === 'string' ? { text: ch } : { text: ch.text || '' })),
                tags: c.tags || [],
                difficulty: c.difficulty || 'medium'
              })),
              tags: d.tags || [],
              difficulty: d.difficulty || 'medium'
            });
          } else {
            series.push({
              id: String(d._id),
              text: d.text,
              choices: (d.choices || []).map(c => (typeof c === 'string' ? { text: c } : { text: c.text || '' })),
              tags: d.tags || [],
              difficulty: d.difficulty || 'medium'
            });
          }
        } // end for qIds

        return res.json({ examId: ex.examId, series });
      } catch (e) {
        console.error("[/api/lms/quiz] examId handling error:", e && (e.stack || e));
        return res.status(500).json({ error: "failed to load exam instance" });
      }
    }

    // --- No examId: fall back to sampling (existing behavior) ----
    // org filter
    let orgId = null;
    if (orgSlug) {
      const org = await Organization.findOne({ slug: orgSlug }).lean();
      if (org) orgId = org._id;
    }

    const match = {};
    if (moduleName) match.module = { $regex: new RegExp(`^${moduleName}$`, "i") };
    if (orgId) match.$or = [{ organization: orgId }, { organization: null }];
    else match.$or = [{ organization: null }, { organization: { $exists: false } }];

    const pipeline = [];
    if (Object.keys(match).length) pipeline.push({ $match: match });
    pipeline.push({ $sample: { size: Math.max(1, Math.min(50, count)) } });

    let docs = [];
    try {
      docs = await Question.aggregate(pipeline).allowDiskUse(true);
    } catch (e) {
      console.error("[/api/lms/quiz] aggregate error:", e && (e.stack || e));
    }

    // map docs into series (no comprehension children in sampling mode)
    const series = (docs || []).map((d) => {
      const isComp = (d && d.type === "comprehension");
      if (isComp) {
        // if comprehension parent encountered in sampling, attempt to fetch child questions lazily is expensive,
        // so keep children empty in sampling mode (client can warn)
        return {
          id: String(d._id),
          type: "comprehension",
          passage: d.passage || "",
          children: [],
          tags: d.tags || [],
          difficulty: d.difficulty || 'medium'
        };
      }
      return {
        id: String(d._id),
        text: d.text,
        choices: (d.choices || []).map(c => (typeof c === 'string' ? { text: c } : { text: c.text || '' })),
        tags: d.tags || [],
        difficulty: d.difficulty || 'medium'
      };
    });

    return res.json({ examId: null, series });
  } catch (err) {
    console.error("[GET /api/lms/quiz] error:", err && (err.stack || err));
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
