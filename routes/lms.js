// routes/lms.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// LMS home
router.get("/", (req, res) => {
  try {
    return res.render("lms/index", { user: req.user || null, courses: [] });
  } catch (err) {
    console.error("[lms/] render error:", err && (err.stack || err));
    return res.status(500).send("LMS render error");
  }
});

// QUIZ UI (demo OR org, same page)
// QUIZ UI (demo OR org, same page)
router.get("/quiz", ensureAuth, (req, res) => {
  try {
    // e.g. ?module=Responsibility&org=muono&examId=...
    const rawModule = String(req.query.module || "Responsibility").trim();
    const moduleKey = rawModule.toLowerCase();     // used for DB filtering
    const orgSlug = String(req.query.org || "").trim();
    const examId = String(req.query.examId || "").trim();

    const isOrg = !!orgSlug;
    const quizCount = isOrg ? 20 : 5;             // 20 for org, 5 for demo
    const moduleLabel = isOrg
      ? rawModule
      : `${rawModule} (demo)`;                    // what appears in heading

    return res.render("lms/quiz", {
      user: req.user || null,
      quizCount,
      module: moduleLabel,                        // display title
      moduleKey,                                  // internal key for API
      orgSlug,
      examId // <- pass examId to the template
    });
  } catch (err) {
    console.error("[lms/quiz] render error:", err && (err.stack || err));
    return res.status(500).send("Failed to render quiz page");
  }
});

export default router;
