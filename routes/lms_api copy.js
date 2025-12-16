// routes/lms_api.js
import { Router } from "express";
import crypto from "crypto";
import Question from "../models/question.js";

const router = Router();

/**
 * In-memory exam store:
 * Map examId -> { answers: { questionId: correctIndex }, createdAt }
 * NOTE: this is ephemeral (lost on restart). For persistence use an Exam collection.
 */
const exams = new Map();
const EXAM_TTL_MS = 1000 * 60 * 30; // 30 minutes

// cleanup interval
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of exams) {
    if (now - v.createdAt > EXAM_TTL_MS) exams.delete(k);
  }
}, 1000 * 60 * 5);

/**
 * Helper: pick N random docs from MongoDB.
 * Uses aggregation $sample if available.
 */
async function sampleQuestions(count = 5) {
  // if you expect many docs, $sample is best:
  try {
    const docs = await Question.aggregate([{ $sample: { size: count } }]);
    return docs;
  } catch (e) {
    // fallback: fetch some and randomize in-memory
    const docs = await Question.find({}).limit(1000).lean();
    // shuffle
    for (let i = docs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [docs[i], docs[j]] = [docs[j], docs[i]];
    }
    return docs.slice(0, Math.min(count, docs.length));
  }
}

/**
 * GET /api/lms/quiz?count=5
 * Returns: { examId, series: [ { id, text, choices:[{text}] } ] }
 * This endpoint will not expose correct answers.
 */
router.get("/api/lms/quiz", async (req, res) => {
  try {
    const count = Math.max(1, Math.min(20, parseInt(req.query.count || "5", 10)));
    // Sample from DB
    const docs = await sampleQuestions(count);
    if (!docs || docs.length === 0) {
      return res.status(404).json({ error: "No questions found in DB. Import questions first." });
    }

    // Build exam key and payload
    const examId = crypto.randomBytes(12).toString("hex");
    const answerKey = {}; // questionId -> answerIndex
    const series = docs.map((d) => {
      const id = String(d._id);
      answerKey[id] = Number(d.answerIndex); // correct index stored server-side
      return {
        id,
        text: d.question || d.text || "",
        choices: (d.choices || []).map((c) => ({ text: c })),
        // DO NOT include answerIndex in response
      };
    });

    // persist in-memory
    exams.set(examId, { answers: answerKey, createdAt: Date.now() });

    return res.json({ examId, series, source: "db", count: series.length });
  } catch (err) {
    console.error("[/api/lms/quiz] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch quiz" });
  }
});

/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [ { questionId, choiceIndex } ] }
 * Returns grading summary.
 */
router.post("/api/lms/quiz/submit", async (req, res) => {
  try {
    const body = req.body || {};
    const examId = body.examId;
    const answersArr = Array.isArray(body.answers) ? body.answers : [];

    if (!examId) return res.status(400).json({ error: "Missing examId" });
    const exam = exams.get(examId);
    if (!exam) return res.status(400).json({ error: "Exam not found or expired. Reload quiz." });

    const answerKey = exam.answers;
    const details = [];
    let score = 0;
    let total = 0;

    for (const a of answersArr) {
      const qid = String(a.questionId || "");
      if (!qid || !(qid in answerKey)) {
        // unknown question (skip)
        continue;
      }
      total++;
      const correctIndex = Number(answerKey[qid]);
      const yourIndex = a.choiceIndex === null || a.choiceIndex === undefined ? null : Number(a.choiceIndex);
      const correct = yourIndex !== null && yourIndex === correctIndex;
      if (correct) score++;
      details.push({
        questionId: qid,
        yourIndex: yourIndex,
        correctIndex: correctIndex,
        correct: !!correct,
      });
    }

    // grading policy
    const percentage = total === 0 ? 0 : Math.round((score / total) * 100);
    const passThreshold = 60; // configurable
    const passed = percentage >= passThreshold;

    // Optionally: record attempt to DB (audit) — not implemented here.

    // delete exam after submission (single-use)
    try { exams.delete(examId); } catch (e) {}

    return res.json({
      score,
      total,
      percentage,
      passThreshold,
      passed,
      details,
    });
  } catch (err) {
    console.error("[/api/lms/quiz/submit] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to grade submission" });
  }
});

export default router;
