// routes/api_lms_org.js
import { Router } from "express";
import QuizQuestion from "../models/quizQuestion.js";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import mongoose from "mongoose";
import crypto from "crypto";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// seeded shuffle — deterministic-ish using crypto HMAC
function seededShuffle(arr, seed) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const h = crypto.createHmac("sha256", String(seed)).update(String(i)).digest("hex");
    const r = parseInt(h.slice(0, 8), 16) / 0xffffffff;
    const j = Math.floor(r * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * GET /api/lms/quiz?org=<slug>&module=<name>&count=20
 * Requires authentication and membership in org
 */
router.get("/quiz", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.query.org || "").trim();
    const moduleName = String(req.query.module || "general").trim();
    const count = Math.max(1, Math.min(50, parseInt(req.query.count || "20", 10)));

    if (!slug) return res.status(400).json({ error: "Missing org slug (org)" });

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).json({ error: "Organization not found" });

    // ensure user is member
    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).json({ error: "Not a member of the organization" });

    // fetch pool of questions for this org+module
    // include global questions (organization=null) and org-specific
    const pool = await QuizQuestion.aggregate([
      { $match: { module: moduleName, $or: [{ organization: null }, { organization: org._id }] } },
      { $project: { text: 1, choices: 1, difficulty: 1 } }
    ]).allowDiskUse(true);

    if (!pool || !pool.length) return res.status(404).json({ error: "No questions available for this org/module" });

    // create seed that varies per user+attempt to avoid identical sequences:
    // use user id + timestamp truncated to minute to make repeating allowed within minute but different across users/time
    const userSeed = String(req.user._id) + ":" + Math.floor(Date.now() / (1000 * 60)).toString();

    // seeded shuffle pool
    const shuffled = seededShuffle(pool, userSeed);

    // pick count items (if pool smaller, return all)
    const pick = shuffled.slice(0, Math.min(count, shuffled.length));

    // map to public shape (no answers)
    const series = pick.map((q, i) => ({
      id: String(q._id || `f-${i}-${Date.now()}`),
      text: q.text,
      choices: (q.choices || []).map(c => ({ text: c })),
      difficulty: q.difficulty || "medium"
    }));

    // exam meta token — not persisted server-side here (client returns ids)
    const examId = crypto.randomUUID();

    return res.json({ examId, org: org.slug, module: moduleName, series });
  } catch (e) {
    console.error("[api_lms_org /quiz] error:", e && e.message);
    return res.status(500).json({ error: "failed to fetch quiz" });
  }
});

/**
 * POST /api/lms/quiz/submit
 * Body: { examId, org, module, answers: [{ questionId, choiceIndex }] }
 * Returns scoring. This endpoint only accepts member submissions.
 */
router.post("/quiz/submit", ensureAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const { examId, org: orgSlug, module } = body;
    const answers = Array.isArray(body.answers) ? body.answers : [];

    if (!orgSlug) return res.status(400).json({ error: "Missing org slug" });
    if (!answers.length) return res.status(400).json({ error: "No answers provided" });

    const org = await Organization.findOne({ slug: orgSlug }).lean();
    if (!org) return res.status(404).json({ error: "Organization not found" });

    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).json({ error: "Not a member of the organization" });

    // gather question ids (only valid ObjectIds)
    const qIds = answers.map(a => a.questionId).filter(Boolean).filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id));

    // load those questions from DB (only if they belong to org or global)
    const docs = await QuizQuestion.find({ _id: { $in: qIds }, module: module || "general", $or: [{ organization: null }, { organization: org._id }] }).lean();

    const docsById = {};
    for (const d of docs) docsById[String(d._id)] = d;

    let score = 0;
    const details = [];

    for (const a of answers) {
      const qid = String(a.questionId || "");
      const yourIdx = Number.isFinite(Number(a.choiceIndex)) ? Number(a.choiceIndex) : null;
      const q = docsById[qid];
      let correctIndex = null;
      if (q && typeof q.answerIndex === "number") correctIndex = q.answerIndex;
      const correct = (correctIndex !== null && yourIdx !== null && correctIndex === yourIdx);
      if (correct) score++;
      details.push({ questionId: qid, yourIndex: yourIdx, correctIndex: correctIndex !== null ? correctIndex : null, correct: !!correct });
    }

    const total = answers.length;
    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = Number(process.env.LMS_PASS_PERCENT || 60);
    const passed = percentage >= passThreshold;

    // Optionally: record Attempt model etc. (left as exercise)
    return res.json({ examId, score, total, percentage, passed, passThreshold, details });
  } catch (e) {
    console.error("[api_lms_org /quiz/submit] error:", e && e.message);
    return res.status(500).json({ error: "submit failed" });
  }
});

export default router;
