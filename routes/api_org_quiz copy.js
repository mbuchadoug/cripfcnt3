// routes/api_org_quiz.js
import { Router } from "express";
import crypto from "crypto";
import mongoose from "mongoose";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import QuizQuestion from "../models/quizQuestion.js"; // your model
import Attempt from "../models/attempt.js";
import ExamInstance from "../models/examInstance.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(crypto.randomInt(0, i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// POST /api/org/:slug/quiz/generate
router.post("/:slug/quiz/generate", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const moduleName = String(req.body.module || "general").trim();
    const count = Math.max(1, Math.min(50, Number(req.body.count || 20)));
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).json({ error: "org not found" });

    // membership check
    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).json({ error: "not a member" });

    // exclude recent qIds for this user + module to reduce repeats
    const lastAttempt = await Attempt.findOne({ userId: req.user._id, organization: org._id, module: moduleName }).sort({ createdAt: -1 }).lean();
    const exclude = lastAttempt && Array.isArray(lastAttempt.questionIds) ? lastAttempt.questionIds.map(String) : [];

    // build match: org-specific OR global (organization null)
    const match = { module: moduleName, $or: [{ organization: null }, { organization: org._id }] };
    if (exclude.length) match._id = { $nin: exclude.map(id => mongoose.Types.ObjectId(id)) };

    // try to sample `count` questions, fallback to allowing previous if pool small
    let docs = await QuizQuestion.aggregate([{ $match: match }, { $sample: { size: count } }]).allowDiskUse(true);
    if (!docs || docs.length < count) {
      docs = await QuizQuestion.aggregate([{ $match: { module: moduleName, $or: [{ organization: null }, { organization: org._id }] } }, { $sample: { size: count } }]).allowDiskUse(true);
    }

    if (!docs || !docs.length) return res.status(404).json({ error: "no questions available" });

    // For each question, create a random choicesOrder mapping shown-index -> original-index
    const questionIds = [];
    const choicesOrder = [];
    const series = [];

    for (const q of docs) {
      questionIds.push(q._id);
      const n = (q.choices || []).length;
      const indices = Array.from({ length: n }, (_, i) => i);
      shuffleArray(indices);
      choicesOrder.push(indices);
      const shownChoices = indices.map(i => ({ text: q.choices[i] }));
      series.push({ questionId: String(q._id), text: q.text, choices: shownChoices });
    }

    const examId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + (1000 * 60 * 60)); // 1 hour

    // persist
    await ExamInstance.create({
      examId, org: org._id, module: moduleName, user: req.user._id, questionIds, choicesOrder, expiresAt, createdByIp: req.ip
    });

    // persist a starter Attempt record (answers empty until submit). Good for progress tracking.
    await Attempt.create({ userId: req.user._id, organization: org._id, module: moduleName, questionIds, startedAt: new Date(), maxScore: questionIds.length });

    return res.json({ examId, expiresAt, series });
  } catch (e) {
    console.error("[api_org_quiz/generate] error:", e && e.stack);
    return res.status(500).json({ error: "failed to generate quiz" });
  }
});

// POST /api/org/:slug/quiz/submit

/*
router.post("/:slug/quiz/submit", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const { examId, answers = [] } = req.body || {};
    if (!examId) return res.status(400).json({ error: "examId required" });
    if (!Array.isArray(answers) || !answers.length) return res.status(400).json({ error: "answers required" });

    const exam = await ExamInstance.findOne({ examId }).lean();
    if (!exam) return res.status(404).json({ error: "exam not found" });
    if (exam.expiresAt && new Date() > new Date(exam.expiresAt)) return res.status(400).json({ error: "exam expired" });

    // ensure membership and ownership
    const org = await Organization.findById(exam.org).lean();
    if (!org) return res.status(404).json({ error: "org not found" });
    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).json({ error: "not a member" });

    // load questions
    const qDocs = await QuizQuestion.find({ _id: { $in: exam.questionIds } }).lean();
    const qById = {};
    for (const q of qDocs) qById[String(q._id)] = q;

    // compute score by mapping shown-index -> original-index using choicesOrder
    let correct = 0;
    const details = [];

    // build index of exam.questionIds for consistent mapping
    for (let i = 0; i < exam.questionIds.length; i++) {
      const qid = String(exam.questionIds[i]);
      const q = qById[qid];
      const mapping = Array.isArray(exam.choicesOrder && exam.choicesOrder[i]) ? exam.choicesOrder[i] : null;
      const given = answers.find(a => String(a.questionId) === qid);
      const yourShownIndex = (given && Number.isFinite(Number(given.choiceIndex))) ? Number(given.choiceIndex) : null;
      // map shown -> original index
      const mappedIndex = (mapping && yourShownIndex !== null && mapping[yourShownIndex] !== undefined) ? mapping[yourShownIndex] : null;
      const correctIndex = (q && typeof q.answerIndex === "number") ? q.answerIndex : null;
      const isCorrect = (mappedIndex !== null && correctIndex !== null && mappedIndex === correctIndex);
      if (isCorrect) correct++;
      details.push({ questionId: qid, yourShownIndex, mappedIndex, correctIndex, correct: !!isCorrect });
    }

    const total = exam.questionIds.length;
    const percentage = Math.round((correct / Math.max(1, total)) * 100);
    const passThreshold = Number(process.env.LMS_PASS_PERCENT || 60);
    const passed = percentage >= passThreshold;

    // update Attempt record (latest one) and mark finished
    await Attempt.findOneAndUpdate({ userId: req.user._id, organization: org._id, module: exam.module }, {
      $set: { finishedAt: new Date(), score: correct, maxScore: total, passed }
    }, { sort: { createdAt: -1 }, upsert: false });

    return res.json({ examId, score: correct, total, percentage, passed, details });
  } catch (e) {
    console.error("[api_org_quiz/submit] error:", e && e.stack);
    return res.status(500).json({ error: "submit failed" });
  }
});*/


// routes/api_org_quiz.js — replace the existing POST "/:slug/quiz/submit" handler with this

router.post("/:slug/quiz/submit", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const { examId, answers = [] } = req.body || {};
    if (!examId) return res.status(400).json({ error: "examId required" });
    if (!Array.isArray(answers) || !answers.length) return res.status(400).json({ error: "answers required" });

    const exam = await ExamInstance.findOne({ examId }).lean();
    if (!exam) return res.status(404).json({ error: "exam not found" });
    if (exam.expiresAt && new Date() > new Date(exam.expiresAt)) return res.status(400).json({ error: "exam expired" });

    // ensure membership and ownership
    const org = await Organization.findById(exam.org).lean();
    if (!org) return res.status(404).json({ error: "org not found" });
    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).json({ error: "not a member" });

    // load questions
    const qDocs = await QuizQuestion.find({ _id: { $in: exam.questionIds } }).lean();
    const qById = {};
    for (const q of qDocs) qById[String(q._id)] = q;

    // compute score by mapping shown-index -> original-index using choicesOrder
    let correct = 0;
    const details = [];

    for (let i = 0; i < exam.questionIds.length; i++) {
      const qid = String(exam.questionIds[i]);
      const q = qById[qid];
      const mapping = Array.isArray(exam.choicesOrder && exam.choicesOrder[i]) ? exam.choicesOrder[i] : null;
      const given = answers.find(a => String(a.questionId) === qid);
      const yourShownIndex = (given && Number.isFinite(Number(given.choiceIndex))) ? Number(given.choiceIndex) : null;

      // map shown -> original index
      const mappedIndex = (mapping && yourShownIndex !== null && mapping[yourShownIndex] !== undefined) ? mapping[yourShownIndex] : null;
      const correctIndex = (q && (typeof q.answerIndex === "number" || typeof q.answerIndex === "string")) ? Number(q.answerIndex) : null;
      const isCorrect = (mappedIndex !== null && correctIndex !== null && mappedIndex === correctIndex);
      if (isCorrect) correct++;

      // For admin review, record the textual choices where available
      const shownChoiceText = (mapping && yourShownIndex !== null && q && q.choices && q.choices[mapping[yourShownIndex]] !== undefined)
        ? q.choices[mapping[yourShownIndex]]
        : null;
      const correctChoiceText = (q && q.choices && typeof correctIndex === "number" && q.choices[correctIndex] !== undefined)
        ? q.choices[correctIndex]
        : null;

      details.push({
        questionId: qid,
        questionText: q ? q.text : null,
        yourShownIndex,
        mappedIndex,
        correctIndex,
        yourAnswerText: shownChoiceText,
        correctAnswerText: correctChoiceText,
        correct: !!isCorrect
      });
    }

    const total = exam.questionIds.length;
    const percentage = Math.round((correct / Math.max(1, total)) * 100);
    const passThreshold = Number(process.env.LMS_PASS_PERCENT || 60);
    const passed = percentage >= passThreshold;

    // update Attempt record (latest one) to include details & finished flag
    await Attempt.findOneAndUpdate(
      { userId: req.user._id, organization: org._id, module: exam.module },
      {
        $set: {
          finishedAt: new Date(),
          score: correct,
          maxScore: total,
          passed,
          answers: details.map(d => ({
            questionId: d.questionId,
            yourShownIndex: d.yourShownIndex,
            mappedIndex: d.mappedIndex,
            correctIndex: d.correctIndex,
            yourAnswerText: d.yourAnswerText,
            correctAnswerText: d.correctAnswerText,
            correct: d.correct
          }))
        }
      },
      { sort: { createdAt: -1 }, upsert: false }
    );

    return res.json({ examId, score: correct, total, percentage, passed, details });
  } catch (e) {
    console.error("[api_org_quiz/submit] error:", e && e.stack);
    return res.status(500).json({ error: "submit failed" });
  }
});


export default router;
