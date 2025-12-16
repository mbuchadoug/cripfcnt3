// routes/lmsAdmin.js
import { Router } from "express";
import QuizQuestion from "../models/quizQuestionF.js";

const router = Router();

// helper: admin check (reads ADMIN_EMAILS env)
function ensureAdmin(req, res, next) {
  // require authentication
  if (!(req.isAuthenticated && req.isAuthenticated())) {
    return res.redirect("/auth/google");
  }
  const email = (req.user && (req.user.email || "") || "").toLowerCase();
  const adminSet = new Set(
    (process.env.ADMIN_EMAILS || "").split(",").map(s => (s || "").trim().toLowerCase()).filter(Boolean)
  );
  if (!email || !adminSet.has(email)) {
    return res.status(403).send("Forbidden — admin only");
  }
  return next();
}

/**
 * GET /admin/lms/questions
 * Simple admin page to list questions with options to delete.
 */
router.get("/lms/questions", ensureAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const filter = {};
    if (q) filter.text = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    const questions = await QuizQuestion.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    return res.render("admin/lms_questions", { title: "LMS Questions", questions, q });
  } catch (err) {
    console.error("[/admin/lms/questions] error:", err);
    return res.status(500).send("Failed to load questions");
  }
});

/**
 * POST /admin/lms/questions/upload
 * Accepts JSON body:
 * {
 *   questions: [
 *     { text: "...", choices: ["a","b","c","d"], answerIndex: 1, tags: ["..."], difficulty: "easy" },
 *     ...
 *   ]
 * }
 *
 * This endpoint inserts many questions at once. If a question object misses required fields it will be rejected.
 */
router.post("/admin/lms/questions/upload", ensureAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    const list = Array.isArray(payload.questions) ? payload.questions : [];
    if (!list.length) return res.status(400).json({ error: "No questions provided" });

    // normalize and validate
    const toInsert = [];
    for (const q of list) {
      const text = (q.text || "").trim();
      const choices = Array.isArray(q.choices) ? q.choices.map(c => ({ text: String(c || "").trim() })).slice(0,4) : [];
      const answerIndex = Number(q.answerIndex);
      if (!text || choices.length !== 4 || Number.isNaN(answerIndex) || answerIndex < 0 || answerIndex > 3) {
        // skip invalid
        continue;
      }
      toInsert.push({
        text,
        choices,
        answerIndex,
        tags: Array.isArray(q.tags) ? q.tags.map(t => String(t || "").trim()).filter(Boolean) : [],
        difficulty: ["easy","medium","hard"].includes(q.difficulty) ? q.difficulty : "medium",
        source: q.source || "admin-upload",
        createdBy: req.user && (req.user.email || null)
      });
    }

    if (!toInsert.length) return res.status(400).json({ error: "No valid questions to insert" });

    const inserted = await QuizQuestion.insertMany(toInsert, { ordered: false });
    return res.json({ inserted: inserted.length });
  } catch (err) {
    console.error("[/admin/lms/questions/upload] error:", err);
    return res.status(500).json({ error: "upload failed", detail: String(err.message || err) });
  }
});

/**
 * POST /admin/lms/questions/:id/delete
 */
router.post("/admin/lms/questions/:id/delete", ensureAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).send("Missing id");
    await QuizQuestion.deleteOne({ _id: id });
    return res.redirect(req.get("referer") || "/admin/lms/questions");
  } catch (err) {
    console.error("[/admin/lms/questions/:id/delete] error:", err);
    return res.status(500).send("Delete failed");
  }
});

export default router;
