// routes/lms.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js"; 
const router = Router();

// Home (optional) — renders views/lms/index.hbs if present
router.get("/", (req, res) => {
  try {
    return res.render("lms/index", { user: req.user || null, courses: [] });
  } catch (err) {
    console.error("[lms/] render error:", err && (err.stack || err));
    return res.status(500).send("LMS render error");
  }
});

// QUIZ UI page
router.get("/quiz",ensureAuth, (req, res) => {
  try {
    return res.render("lms/quiz", { user: req.user || null });
  } catch (err) {
    console.error("[lms/quiz] render error:", err && (err.stack || err));
    return res.status(500).send("Failed to render quiz page");
  }
});


/*
router.get("/quiz", ensureAuth, async (req, res) => {
  try {
    const user = req.user;
    const orgId = req.query.org || String(user.organization);
    const moduleKey = String(req.query.module || "default");
    const count = Math.max(1, Math.min(50, parseInt(req.query.count || "20", 10)));

    // Basic org membership check
    if (!orgId) return res.status(400).json({ error: "organization required" });
    if (String(user.organization) !== String(orgId)) {
      // allow org_admins or super_admins to view
      if (!(user.role === "org_admin" || user.role === "super_admin")) {
        return res.status(403).json({ error: "not a member of organization" });
      }
    }

    // Find last attempt by user for this module/org to optionally exclude questions
    const lastAttempt = await Attempt.findOne({ userId: user._id, organization: orgId, module: moduleKey }).sort({ createdAt: -1 }).lean();
    const excludeIds = (lastAttempt && lastAttempt.questionIds) ? lastAttempt.questionIds.map(String) : [];

    // Query pool: match org & module (allow global questions if you want with organization: null)
    const match = {
      $or: [
        { organization: mongoose.Types.ObjectId(orgId) },
        { organization: null } // optional shared pool
      ],
      module: moduleKey
    };

    if (excludeIds.length) {
      match._id = { $nin: excludeIds.map(id => mongoose.Types.ObjectId(id)) };
    }

    // Sample pool -- if pool smaller than count, fallback to allowing repeats
    let pipeline = [{ $match: match }, { $sample: { size: count } }];
    let docs = await Question.aggregate(pipeline).allowDiskUse(true);

    if (!docs || docs.length < count) {
      // fallback: allow previously excluded questions (so we still return count)
      const fallback = await Question.aggregate([{ $match: { $or: [{ organization: mongoose.Types.ObjectId(orgId) }, { organization: null }], module: moduleKey } }, { $sample: { size: count } }]).allowDiskUse(true);
      docs = fallback;
    }

    // Build series without revealing correctIndex
    const series = docs.map(q => ({
      id: String(q._id),
      text: q.text,
      choices: (q.choices || []).map(c => ({ text: c.text })),
      difficulty: q.difficulty || "medium",
      tags: q.tags || []
    }));

    // Save an Attempt record with questionIds served (answers empty until submit)
    const attempt = await Attempt.create({
      userId: user._id,
      organization: orgId,
      module: moduleKey,
      questionIds: docs.map(d => d._id),
      startedAt: new Date()
    });

    return res.json({ examId: String(attempt._id), series, total: series.length });
  } catch (err) {
    console.error("[org-quiz] error:", err && err.stack);
    return res.status(500).json({ error: "failed to build quiz" });
  }
});*/

export default router;
