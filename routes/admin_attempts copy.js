// routes/admin_attempts.js
import { Router } from "express";
import mongoose from "mongoose";
import Organization from "../models/organization.js";
import Attempt from "../models/attempt.js";
import User from "../models/user.js";
import { ensureAuth } from "../middleware/authGuard.js";

// reuse your admin email check (if in admin.js you can import; otherwise copy function)
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

// List attempts for org
router.get("/admin/orgs/:slug/attempts", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const attempts = await Attempt.find({ organization: org._id })
      .sort({ createdAt: -1 })
      .populate("userId", "name email")
      .lean();

    return res.render("admin/org_attempts", { org, attempts });
  } catch (err) {
    console.error("[admin attempts list] error:", err && err.stack);
    return res.status(500).send("failed");
  }
});

// View single attempt detail
router.get("/admin/orgs/:slug/attempts/:attemptId", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const attemptId = String(req.params.attemptId || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    if (!mongoose.isValidObjectId(attemptId)) return res.status(400).send("invalid attempt id");

    const attempt = await Attempt.findById(attemptId).populate("userId", "name email").lean();
    if (!attempt) return res.status(404).send("attempt not found");

    // attempt.answers is expected to be an array with per-question details (as saved earlier)
    const answers = Array.isArray(attempt.answers) ? attempt.answers : [];

    return res.render("admin/org_attempt_detail", { org, attempt, answers, user: attempt.userId });
  } catch (err) {
    console.error("[admin attempt detail] error:", err && err.stack);
    return res.status(500).send("failed");
  }
});

export default router;
