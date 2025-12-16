// routes/lms_api.js  (REPLACE WHOLE FILE)
import { Router } from "express";
import mongoose from "mongoose";
import Question from "../models/question.js";
import Organization from "../models/organization.js";
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";
import fs from "fs";
import path from "path";

const router = Router();

// fallback file loader (like before)
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
      choices: (d.choices || []).map((c) => ({ text: c.text || c })),
      correctIndex:
        typeof d.correctIndex === "number" ? d.correctIndex : null,
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
 * - returns { examId, series }
 * - also persists a light ExamInstance on the server so submit can validate examId
 */
router.get("/quiz", async (req, res) => {
  let count = parseInt(req.query.count || "5", 10);
  if (!Number.isFinite(count)) count = 5;
  count = Math.max(1, Math.min(50, count));

  const moduleKey = String(req.query.module || "").trim().toLowerCase();
  const orgSlug = String(req.query.org || "").trim();

  try {
    let orgId = null;
    if (orgSlug) {
      const org = await Organization.findOne({ slug: orgSlug }).lean();
      if (org) orgId = org._id;
    }

    const match = {};
    if (moduleKey) {
      match.module = { $regex: new RegExp(`^${moduleKey}$`, "i") };
    }
    if (orgId) {
      match.$or = [{ organization: orgId }, { organization: null }];
    }

    const pipeline = [];
    if (Object.keys(match).length) pipeline.push({ $match: match });
    pipeline.push({ $sample: { size: count } });

    let docs = [];
    try {
      docs = await Question.aggregate(pipeline).allowDiskUse(true);
    } catch (e) {
      console.error("[/api/lms/quiz] aggregate error:", e && (e.stack || e));
    }

    let series;
    let questionIdsForInstance = [];
    if (docs && docs.length) {
      series = docs.map((d) => {
        questionIdsForInstance.push(String(d._id)); // valid ObjectId strings
        return {
          id: String(d._id),
          text: d.text,
          choices: (d.choices || []).map((c) => ({ text: c.text || c })),
          tags: d.tags || [],
          difficulty: d.difficulty || "medium",
        };
      });
    } else {
      // fallback to static file
      series = fetchRandomQuestionsFromFile(count);
      // file IDs are not ObjectIds; we won't populate questionIdsForInstance for those
    }

    const examId = "exam-" + Date.now().toString(36);

    // create/stash an ExamInstance document so submit can verify the examId
    try {
      const examDoc = {
        examId,
        org: orgId || null,
        module: moduleKey || "general",
        user: req.user && req.user._id ? req.user._id : null,
        questionIds: questionIdsForInstance, // array of ObjectId strings (or empty)
        choicesOrder: [], // if you later randomize choice order, store mapping here
        createdAt: new Date(),
        // expiresAt could be set to e.g. now + 1 hour if you want
      };

      await ExamInstance.create(examDoc);
    } catch (e) {
      // Non-fatal: log but still return the series so client can proceed
      console.error("[/api/lms/quiz] failed to create ExamInstance:", e && (e.stack || e));
    }

    return res.json({ examId, series });
  } catch (err) {
    console.error("[GET /api/lms/quiz] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch quiz" });
  }
});

/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [{ questionId, choiceIndex }] }
 * - Scores answers
 * - Persists an Attempt document (finished)
 * - Updates ExamInstance (optional)
 */
/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [{ questionId, choiceIndex }], module?, org? }
 */
router.post("/quiz/submit", async (req, res) => {
  try {
    const payload = req.body || {};
    console.log("[quiz/submit] payload:", JSON.stringify(payload).slice(0, 2000)); // truncated log

    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    if (!answers.length) return res.status(400).json({ error: "No answers submitted" });

    const examId = String(payload.examId || "").trim() || null;
    const moduleKey = String(payload.module || "").trim() || null;
    const orgSlugOrId = payload.org || null;

    // Build set of question ids user submitted
    const qIds = answers.map(a => a.questionId).filter(Boolean).map(String);
    console.log("[quiz/submit] qIds:", qIds.length, qIds.slice(0,10));

    // Try to find an ExamInstance if examId provided
    let exam = null;
    if (examId) {
      exam = await ExamInstance.findOne({ examId }).lean().exec().catch(e => {
        console.error("[quiz/submit] exam lookup error:", e && e.stack);
        return null;
      });
      console.log("[quiz/submit] exam found?:", !!exam, examId);
    }

    const byId = {};

    // load DB question docs for ObjectId-like ids
    const dbIds = qIds.filter(id => mongoose.isValidObjectId(id));
    if (dbIds.length) {
      try {
        const qDocs = await Question.find({ _id: { $in: dbIds } }).lean().exec();
        for (const q of qDocs) byId[String(q._id)] = q;
        console.log("[quiz/submit] loaded DB questions:", Object.keys(byId).length);
      } catch (e) {
        console.error("[quiz/submit] DB lookup error:", e && (e.stack || e));
      }
    }

    // file fallback
    try {
      const p = path.join(process.cwd(), "data", "data_questions.json");
      if (fs.existsSync(p)) {
        const fileQ = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const fq of fileQ) {
          const fid = String(fq.id || fq._id || fq.uuid || "");
          if (fid && !byId[fid]) byId[fid] = fq;
        }
        console.log("[quiz/submit] file fallback entries:", Object.keys(byId).length);
      }
    } catch (e) {
      console.error("[quiz/submit] file fallback error:", e && (e.stack || e));
    }

    // scoring
    let score = 0;
    const details = [];
    const savedAnswers = [];

    for (const a of answers) {
      const qid = String(a.questionId || "");
      const yourIndex = (typeof a.choiceIndex === "number") ? a.choiceIndex : null;
      const q = byId[qid] || null;

      let correctIndex = null;
      if (q) {
        if (typeof q.correctIndex === "number") correctIndex = q.correctIndex;
        else if (typeof q.answerIndex === "number") correctIndex = q.answerIndex;
        else if (typeof q.correct === "number") correctIndex = q.correct;
      }

      const correct = (correctIndex !== null && yourIndex !== null && correctIndex === yourIndex);
      if (correct) score++;

      details.push({
        questionId: qid,
        correctIndex: (correctIndex !== null) ? correctIndex : null,
        yourIndex,
        correct: !!correct,
      });

      const qObjId = mongoose.isValidObjectId(qid) ? mongoose.Types.ObjectId(qid) : qid;
      savedAnswers.push({
        questionId: qObjId,
        choiceIndex: (typeof yourIndex === 'number') ? yourIndex : null
      });
    }

    const total = answers.length;
    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = 60;
    const passed = percentage >= passThreshold;

    // find existing attempt (prefer examId)
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
    console.log("[quiz/submit] attemptFilter:", attemptFilter);

    let attempt = null;
    try {
      if (Object.keys(attemptFilter).length) {
        attempt = await Attempt.findOne(attemptFilter).sort({ createdAt: -1 }).exec();
      }
    } catch (e) {
      console.error("[quiz/submit] attempt lookup error:", e && (e.stack || e));
    }
    console.log("[quiz/submit] attempt found?:", !!attempt, attempt ? attempt._id : null);

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
        console.log("[quiz/submit] updated attempt:", attempt._id);
      } catch (e) {
        console.error("[quiz/submit] attempt update failed:", e && (e.stack || e));
      }
    } else {
      try {
        const newA = await Attempt.create(attemptDoc);
        savedAttempt = await Attempt.findById(newA._id).lean().exec();
        console.log("[quiz/submit] created attempt:", newA._id);
      } catch (e) {
        console.error("[quiz/submit] attempt create failed:", e && (e.stack || e));
      }
    }

    // also update ExamInstance (optional) to mark it used/finished
    if (exam) {
      try {
        await ExamInstance.updateOne({ examId: exam.examId }, { $set: { updatedAt: now, expiresAt: now } }).exec();
      } catch (e) {
        console.error("[quiz/submit] failed to update examInstance:", e && (e.stack || e));
      }
    }

    // Return full summary + saved attempt (debug)
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
        attemptSaved: !!savedAttempt,
        attempt: savedAttempt
      }
    });
  } catch (err) {
    console.error("[POST /api/lms/quiz/submit] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to score quiz", detail: String(err && err.message) });
  }
});



export default router;
