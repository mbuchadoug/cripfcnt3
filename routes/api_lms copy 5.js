// routes/api_lms.js
import { Router } from "express";
import mongoose from "mongoose";
import Question from "../models/question.js";
import Organization from "../models/organization.js";
import fs from "fs";
import path from "path";

const router = Router();

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
router.get("/quiz", async (req, res) => {
  // default 5, max 20, min 1
  let rawCount = parseInt(req.query.count || "5", 10);
  if (!Number.isFinite(rawCount)) rawCount = 5;
  const count = Math.max(1, Math.min(20, rawCount));

  const moduleName = String(req.query.module || "").trim(); // e.g. "Responsibility"
  const orgSlug = String(req.query.org || "").trim();       // e.g. "muono"

  try {
    // try DB first (your imported questions live here)
    const dbResult = await fetchRandomQuestionsFromDB(count, {
      moduleName,
      orgSlug,
    });

    let series = [];
    if (dbResult && dbResult.length >= 1) {
      series = dbResult;
    } else {
      // fallback to file (dev only)
      series = fetchRandomQuestionsFromFile(count);
    }

    // don’t expose correctIndex to the client
    const publicSeries = series.map((q) => ({
      id: q.id,
      text: q.text,
      choices: q.choices.map((c) => ({ text: c.text })),
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
