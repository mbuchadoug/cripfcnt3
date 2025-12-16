// routes/lms_api.js  (REPLACE WHOLE FILE)
import { Router } from "express";
import mongoose from "mongoose";
import Question from "../models/question.js";
import Organization from "../models/organization.js";
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
      // case-insensitive match on module
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
    if (docs && docs.length) {
      series = docs.map((d) => ({
        id: String(d._id),
        text: d.text,
        choices: (d.choices || []).map((c) => ({ text: c.text || c })),
        tags: d.tags || [],
        difficulty: d.difficulty || "medium",
      }));
    } else {
      // fallback to static file
      series = fetchRandomQuestionsFromFile(count);
    }

    const examId = "exam-" + Date.now().toString(36);
    return res.json({ examId, series });
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

    const qIds = answers.map((a) => a.questionId).filter(Boolean).map(String);
    const dbIds = qIds.filter((id) => mongoose.isValidObjectId(id));

    const byId = {};
    if (dbIds.length) {
      try {
        const docs = await Question.find({ _id: { $in: dbIds } }).lean().exec();
        for (const q of docs) byId[String(q._id)] = q;
      } catch (e) {
        console.error("[quiz/submit] DB lookup error:", e && (e.stack || e));
      }
    }

    // optional file fallback (keep old behaviour)
    try {
      const missing = qIds.filter((id) => !byId[id]);
      if (missing.length) {
        const p = path.join(process.cwd(), "data", "data_questions.json");
        if (fs.existsSync(p)) {
          const fileQuestions = JSON.parse(fs.readFileSync(p, "utf8"));
          for (const fq of fileQuestions) {
            const fid = String(fq.id || fq._id || fq.uuid);
            if (fid && !byId[fid]) byId[fid] = fq;
          }
        }
      }
    } catch (e) {
      console.error("[quiz/submit] file fallback error:", e && (e.stack || e));
    }

    let score = 0;
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
        correctIndex: correctIndex !== null ? correctIndex : null,
        yourIndex,
        correct: !!correct,
      });
    }

    const total = answers.length;
    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = 60;
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
