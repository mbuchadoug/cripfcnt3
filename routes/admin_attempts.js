// routes/admin_attempts.js
import { Router } from "express";
import mongoose from "mongoose";
import Organization from "../models/organization.js";
import Attempt from "../models/attempt.js";
import User from "../models/user.js";
import Question from "../models/question.js";
import ExamInstance from "../models/examInstance.js";
import { ensureAuth } from "../middleware/authGuard.js";

function getAdminSet() {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}
function ensureAdminEmails(req, res, next) {
  const adminEmails = Array.from(getAdminSet());
  if (!req.user || !req.user.email) return res.status(403).send("Admins only");
  if (!adminEmails.includes(req.user.email.toLowerCase())) return res.status(403).send("Admins only");
  next();
}

const router = Router();

router.get("/admin/orgs/:slug/attempts", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    // show most recent attempts (populate userId for convenience)
    const attempts = await Attempt.find({ organization: org._id })
      .sort({ createdAt: -1 })
      .populate("userId", "name email")
      .lean();

    // render
    return res.render("admin/org_attempts", { org, attempts });
  } catch (err) {
    console.error("[admin attempts list] error:", err && err.stack);
    return res.status(500).send("failed");
  }
});

router.get("/admin/orgs/:slug/attempts/:attemptId", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const attemptId = String(req.params.attemptId || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    if (!mongoose.isValidObjectId(attemptId)) return res.status(400).send("invalid attempt id");

    // Load attempt (no populate of questions here — we'll fetch questions separately)
    const attempt = await Attempt.findById(attemptId).lean();
    if (!attempt) return res.status(404).send("attempt not found");

    // Resolve user info (attempt may have userId populated or just an id)
    let user = null;
    if (attempt.userId) {
      try {
        user = await User.findById(attempt.userId, "name email").lean();
      } catch (e) {
        user = null;
      }
    }

    // Build the canonical list of questionIds in order:
    // Prefer attempt.questionIds (saved when exam started); fallback to ExamInstance.questionIds if available
    let orderedQIds = Array.isArray(attempt.questionIds) && attempt.questionIds.length
      ? attempt.questionIds.map(String)
      : [];

    if (!orderedQIds.length && attempt.examId) {
      try {
        const exam = await ExamInstance.findOne({ examId: attempt.examId }).lean().exec();
        if (exam && Array.isArray(exam.questionIds) && exam.questionIds.length) {
          orderedQIds = exam.questionIds.map(String);
        }
      } catch (e) {
        console.error("[admin attempt detail] examInstance lookup failed:", e && e.stack);
      }
    }

    // Build map of provided answers (attempt.answers may be empty or missing)
    // attempt.answers expected shape: [{ questionId: ObjectId, choiceIndex: Number }]
    const answerMap = {};
    if (Array.isArray(attempt.answers)) {
      for (const a of attempt.answers) {
        if (a && a.questionId != null) answerMap[String(a.questionId)] = (typeof a.choiceIndex === "number") ? a.choiceIndex : null;
      }
    }

    // If we still have no orderedQIds, try to extract question ids from answers keys
    if (!orderedQIds.length && Object.keys(answerMap).length) {
      orderedQIds = Object.keys(answerMap);
    }

    // Fetch question docs for these ids (only for valid ObjectIds)
    const validDbIds = orderedQIds.filter(id => mongoose.isValidObjectId(id));
    let questions = [];
    if (validDbIds.length) {
      questions = await Question.find({ _id: { $in: validDbIds } }).lean().exec();
    }

    // Create a map for quick lookup
    const qById = {};
    for (const q of questions) qById[String(q._id)] = q;

    // Build details array in the requested order
    const details = [];
    for (let i = 0; i < orderedQIds.length; i++) {
      const qid = orderedQIds[i];
      const qdoc = qById[qid] || null;

      // Determine correctIndex from qdoc if present (support multiple field names)
      let correctIndex = null;
      if (qdoc) {
        if (typeof qdoc.correctIndex === "number") correctIndex = qdoc.correctIndex;
        else if (typeof qdoc.answerIndex === "number") correctIndex = qdoc.answerIndex;
        else if (typeof qdoc.correct === "number") correctIndex = qdoc.correct;
      }

      const yourIndex = Object.prototype.hasOwnProperty.call(answerMap, qid) ? answerMap[qid] : null;
      const correct = (correctIndex !== null && yourIndex !== null && correctIndex === yourIndex);

      // Normalize choices to array of { text }
      let choices = [];
      if (qdoc && Array.isArray(qdoc.choices)) {
        choices = qdoc.choices.map((c) => (typeof c === "string" ? { text: c } : { text: c && c.text ? c.text : "" }));
      }

      details.push({
        qIndex: i + 1,
        questionId: qid,
        questionText: qdoc ? (qdoc.text || "(no text)") : "(question not in DB)",
        choices,
        yourIndex,
        correctIndex: correctIndex !== null ? correctIndex : null,
        correct: !!correct
      });
    }

    // Render the admin attempt detail page with details and user info
    return res.render("admin/org_attempt_detail", {
      org,
      attempt,
      details,
      user,
    });
  } catch (err) {
    console.error("[admin attempt detail] error:", err && err.stack);
    return res.status(500).send("failed");
  }
});

export default router;
