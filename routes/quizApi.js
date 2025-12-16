// routes/quizApi.js
import { Router } from "express";
import QuizQuestion from "../models/quizQuestionF.js";
import crypto from "crypto";

const router = Router();

/**
 * GET /api/lms/quiz
 * Query: ?count=5
 * Returns "count" random questions (without revealing answerIndex).
 * Response:
 * {
 *   examId: "<uuid>",
 *   expiresAt: "<ISO>",
 *   series: [{ id, text, choices: [{ text }], tags, difficulty }]
 * }
 */
router.get("/lms/quiz", async (req, res) => {
  try {
    const count = Math.max(1, Math.min(50, parseInt(req.query.count || "5", 10)));
    // sample random documents
    const pipeline = [{ $sample: { size: count } }, { $project: { text: 1, choices: 1, tags: 1, difficulty: 1 } }];
    const series = await QuizQuestion.aggregate(pipeline).allowDiskUse(true);

    // map to safe format (id as string)
    const payloadSeries = series.map(q => ({
      id: String(q._id),
      text: q.text,
      choices: (q.choices || []).map(c => ({ text: c.text })),
      tags: q.tags || [],
      difficulty: q.difficulty || "medium"
    }));

    // examId (not stored server-side for now). Client should return the question ids they answered.
    const examId = crypto.randomUUID();
    // optional expiry (for anti-cheat)
    const expiresAt = new Date(Date.now() + 1000 * 60 * 30).toISOString(); // 30 minutes

    return res.json({ examId, expiresAt, series: payloadSeries });
  } catch (err) {
    console.error("[GET /api/lms/quiz] error:", err);
    return res.status(500).json({ error: "failed to load quiz" });
  }
});

/**
 * POST /api/lms/quiz/submit
 * Body:
 * {
 *   examId: "<uuid>",
 *   answers: [{ questionId: "<id>", choiceIndex: 0|1|2|3 }, ... ],
 *   meta: { durationSeconds: 90 } // optional
 * }
 *
 * Response:
 * { score, total, correct: [{ questionId, correctIndex }], details: [{ questionId, correctIndex, yourIndex, correct }] }
 *
 * NOTE: we do not reveal the correct answers client-side until after scoring (we include them in response so UI can show feedback).
 */
router.post("/lms/quiz/submit", async (req, res) => {
  try {
    const body = req.body || {};
    const answers = Array.isArray(body.answers) ? body.answers : [];
    if (!answers.length) return res.status(400).json({ error: "No answers provided" });

    // gather question ids
    const qids = [...new Set(answers.map(a => String(a.questionId)).filter(Boolean))];
    if (!qids.length) return res.status(400).json({ error: "No valid question ids" });

    const docs = await QuizQuestion.find({ _id: { $in: qids } }).lean();
    const docsById = {};
    for (const d of docs) docsById[String(d._id)] = d;

    let correctCount = 0;
    const details = [];
    const correct = [];

    for (const ans of answers) {
      const qid = String(ans.questionId);
      const yourIndex = Number.isFinite(Number(ans.choiceIndex)) ? Number(ans.choiceIndex) : null;
      const q = docsById[qid];
      if (!q || yourIndex === null) {
        details.push({ questionId: qid, correct: false, yourIndex, correctIndex: null });
        continue;
      }
      const isCorrect = q.answerIndex === yourIndex;
      if (isCorrect) correctCount++;
      details.push({ questionId: qid, correct: isCorrect, yourIndex, correctIndex: q.answerIndex });
      correct.push({ questionId: qid, correctIndex: q.answerIndex });
    }

    const total = answers.length;
    const score = correctCount;
    const percentage = Math.round((score / total) * 100);

    // optional: determine pass threshold (env or default 60)
    const passThreshold = Number(process.env.LMS_PASS_PERCENT || "60");
    const passed = percentage >= passThreshold;

    // return feedback (including correct indices so UI can show them)
    return res.json({
      score,
      total,
      percentage,
      passed,
      passThreshold,
      details,
      correct // minimal correct answers
    });
  } catch (err) {
    console.error("[POST /api/lms/quiz/submit] error:", err);
    return res.status(500).json({ error: "submit failed", detail: String(err.message || err) });
  }
});

export default router;
