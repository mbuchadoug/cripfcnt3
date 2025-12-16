// routes/api_lms.js
import { Router } from "express";
import Question from "../models/question.js";
import fs from "fs";
import path from "path";

const router = Router();

// helper: sample N random docs using Mongo's aggregation if available
async function fetchRandomQuestionsFromDB(count = 5) {
  // prefer aggregation $sample for randomness
  try {
    const docs = await Question.aggregate([{ $sample: { size: Number(count) } }]);
    // map to API shape
    return docs.map(d => ({
      id: String(d._id),
      text: d.text,
      choices: (d.choices || []).map(c => ({ text: c.text })),
      correctIndex: typeof d.correctIndex === "number" ? d.correctIndex : null,
      tags: d.tags || [],
      difficulty: d.difficulty || "medium",
    }));
  } catch (err) {
    console.error("[fetchRandomQuestionsFromDB] error:", err && (err.stack || err));
    return null;
  }
}

// fallback: load static file data/data_questions.json if DB missing (useful during dev)
function fetchRandomQuestionsFromFile(count = 5) {
  try {
    const p = path.join(process.cwd(), "data", "data_questions.json");
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const all = JSON.parse(raw);
    // shuffle and take count
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return (all.slice(0, count)).map(d => ({
      id: d.id || d._id || d.uuid || ("fid-" + Math.random().toString(36).slice(2,9)),
      text: d.text,
      choices: (d.choices || []).map(c => ({ text: c.text || c })),
      correctIndex: typeof d.correctIndex === "number" ? d.correctIndex : null,
      tags: d.tags || [],
      difficulty: d.difficulty || "medium",
    }));
  } catch (err) {
    console.error("[fetchRandomQuestionsFromFile] error:", err && (err.stack || err));
    return [];
  }
}

/**
 * GET /api/lms/quiz?count=5
 * Returns: { examId, series: [{id,text,choices:[{text}],tags,difficulty}] }
 */
router.get("/quiz", async (req, res) => {
  const count = Math.max(1, Math.min(20, parseInt(req.query.count || "5", 10)));
  try {
    // try DB first
    const dbResult = await fetchRandomQuestionsFromDB(count);
    let series = [];
    if (dbResult && dbResult.length >= 1) {
      series = dbResult;
    } else {
      // fallback to file
      series = fetchRandomQuestionsFromFile(count);
    }

    // remove correctIndex before sending (UI shouldn't receive correctIndex)
    const publicSeries = series.map(q => ({
      id: q.id,
      text: q.text,
      choices: q.choices.map(c => ({ text: c.text })),
      tags: q.tags || [],
      difficulty: q.difficulty || "medium",
    }));

    const examId = "exam-" + Date.now().toString(36);
    return res.json({ examId, series: publicSeries });
  } catch (err) {
    console.error("[GET /api/lms/quiz] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch quiz" });
  }
});

/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [{ questionId, choiceIndex }] }
 *
 * Returns scoring:
 *  { examId, total, score, percentage, passThreshold, passed, details: [{questionId, correctIndex, yourIndex, correct}] }
 */
router.post("/quiz/submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    if (!answers.length) return res.status(400).json({ error: "No answers submitted" });

    // For each questionId we need the correctIndex
    const qIds = answers.map(a => a.questionId).filter(Boolean);
    const results = [];

    // fetch from DB for those IDs
    const fromDb = await Question.find({ _id: { $in: qIds } }).lean().exec();
    const byId = {};
    for (const q of fromDb) {
      byId[String(q._id)] = q;
    }

    // fallback: if not found in DB maybe question came from static file - try loading file
    let fileQuestions = null;
    const missingIds = qIds.filter(id => !byId[id]);
    if (missingIds.length) {
      // load static file only once
      try {
        const p = path.join(process.cwd(), "data", "data_questions.json");
        if (fs.existsSync(p)) {
          fileQuestions = JSON.parse(fs.readFileSync(p, "utf8"));
          for (const fq of fileQuestions) {
            const fid = String(fq.id || fq._id || fq.uuid);
            if (!byId[fid]) {
              byId[fid] = fq; // not mongoose doc but has correctIndex if present
            }
          }
        }
      } catch (e) {
        console.error("[quiz/submit] file load err:", e && (e.stack || e));
      }
    }

    let score = 0;
    const total = answers.length;
    const details = [];

    for (const a of answers) {
      const q = byId[String(a.questionId)];
      const yourIndex = (typeof a.choiceIndex === "number") ? a.choiceIndex : null;
      const correctIndex = q && (typeof q.correctIndex === "number") ? q.correctIndex : (q && q.correct && typeof q.correct === "number" ? q.correct : null);

      const correct = (correctIndex !== null && yourIndex !== null && correctIndex === yourIndex);
      if (correct) score++;

      details.push({
        questionId: a.questionId,
        correctIndex: correctIndex,
        yourIndex: yourIndex,
        correct: !!correct,
      });
    }

    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = 60; // configurable if you want
    const passed = percentage >= passThreshold;

    return res.json({
      examId: payload.examId || ("exam-" + Date.now().toString(36)),
      total,
      score,
      percentage,
      passThreshold,
      passed,
      details,
    });
  } catch (err) {
    console.error("[POST /api/lms/quiz/submit] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to score quiz" });
  }
});

export default router;
