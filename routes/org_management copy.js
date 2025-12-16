// routes/org_management.js
import { Router } from "express";
import crypto from "crypto";
import nodemailer from "nodemailer";
import mongoose from "mongoose";
import Organization from "../models/organization.js";
import OrgInvite from "../models/orgInvite.js";
import OrgMembership from "../models/orgMembership.js";
import OrgModule from "../models/orgModule.js";
import User from "../models/user.js";
import ExamInstance from "../models/examInstance.js";
import QuizQuestion from "../models/question.js";
import Attempt from "../models/attempt.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

/**
 * Admin check - replace if you have a different admin logic.
 * This checks process.env.ADMIN_EMAILS (comma separated).
 */
function ensureAdminEmails(req, res, next) {
  const adminEmails = (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!req.user || !req.user.email) return res.status(403).send("Admins only");
  if (!adminEmails.includes(req.user.email.toLowerCase())) return res.status(403).send("Admins only");
  next();
}

/**
 * Create / configure nodemailer transporter if SMTP env is present.
 * Required env:
 *  - SMTP_HOST
 *  - SMTP_PORT (optional, default 587)
 *  - SMTP_USER
 *  - SMTP_PASS
 *  - BASE_URL (for invite links)
 */
function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

const transporter = createTransporter();
const BASE_URL = process.env.BASE_URL || "";

/**
 * ADMIN: Send invite (POST)
 * body: { email, role }
 * Returns JSON { ok: true, token } or error.
 */
router.post("/admin/orgs/:slug/invite", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = String(req.body.role || "employee");

    if (!email) return res.status(400).json({ error: "email required" });

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).json({ error: "org not found" });

    const token = crypto.randomBytes(16).toString("hex");
    const invite = await OrgInvite.create({ orgId: org._id, email, token, role });

    // Attempt to send email (best-effort)
    if (transporter && BASE_URL) {
      const inviteUrl = `${BASE_URL.replace(/\/$/, "")}/org/join/${token}`;
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: email,
          subject: `Invite to join ${org.name}`,
          text: `You've been invited to join organization ${org.name}. Click to accept: ${inviteUrl}`,
          html: `<p>You've been invited to join <strong>${org.name}</strong>.</p><p><a href="${inviteUrl}">Click here to accept the invite</a></p>`
        });
      } catch (e) {
        console.warn("[invite email] send failed:", e && e.stack || e);
      }
    }

    return res.json({ ok: true, token: invite.token });
  } catch (err) {
    console.error("[admin invite] error:", err && (err.stack || err));
    return res.status(500).json({ error: "invite failed" });
  }
});

/**
 * ADMIN: Manage page view
 */
router.get("/admin/orgs/:slug/manage", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const invites = await OrgInvite.find({ orgId: org._id }).sort({ createdAt: -1 }).lean();
    const memberships = await OrgMembership.find({ org: org._id }).populate("user").lean();
    const modules = await OrgModule.find({ org: org._id }).lean();

    return res.render("admin/org_manage", { org, invites, memberships, modules });
  } catch (err) {
    console.error("[admin org manage] error:", err && (err.stack || err));
    return res.status(500).send("failed");
  }
});

/**
 * PUBLIC: Join via invite token (GET). If logged in, attach membership.
 * If not logged in: you should redirect to login and preserve token in session.
 */
router.get("/org/join/:token", ensureAuth, async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!token) return res.status(400).send("token required");

    const invite = await OrgInvite.findOne({ token, used: false }).lean();
    if (!invite) return res.status(404).send("invite not found or used");

    // attach membership
    await OrgMembership.findOneAndUpdate(
      { org: invite.orgId, user: req.user._id },
      { $set: { role: invite.role, joinedAt: new Date() } },
      { upsert: true }
    );

    await OrgInvite.updateOne({ _id: invite._id }, { $set: { used: true } });

    const org = await Organization.findById(invite.orgId).lean();
    return res.redirect(`/org/${org.slug}/dashboard`);
  } catch (err) {
    console.error("[org/join] error:", err && (err.stack || err));
    return res.status(500).send("join failed");
  }
});

/**
 * ADMIN: Member actions (AJAX-friendly)
 * POST /admin/orgs/:slug/members/:userId
 * body: { action: "promote"|"demote"|"remove", role }
 */
router.post("/admin/orgs/:slug/members/:userId", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const userId = req.params.userId;
    const action = String(req.body.action || "").trim();
    const role = String(req.body.role || "manager");

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).json({ error: "org not found" });

    if (action === "remove") {
      await OrgMembership.deleteOne({ org: org._id, user: userId });
      return res.json({ ok: true, action: "removed" });
    } else if (action === "promote") {
      await OrgMembership.findOneAndUpdate({ org: org._id, user: userId }, { $set: { role } }, { upsert: true });
      return res.json({ ok: true, action: "promoted", role });
    } else if (action === "demote") {
      await OrgMembership.findOneAndUpdate({ org: org._id, user: userId }, { $set: { role: "employee" } });
      return res.json({ ok: true, action: "demoted" });
    } else {
      return res.status(400).json({ error: "invalid action" });
    }
  } catch (err) {
    console.error("[admin member action] error:", err && (err.stack || err));
    return res.status(500).json({ error: "failed" });
  }
});

/**
 * ASSIGN QUIZ (ADMIN or manager):
 * POST /admin/orgs/:slug/assign-quiz
 * body: { module, userIds: [id,...], count: 20, expiresMinutes: 60 }
 *
 * This will create one ExamInstance per user (persisted) + empty Attempt record.
 * Returns { assigned: [{ userId, examId, url }], errors: [...] }
 */
router.post("/admin/orgs/:slug/assign-quiz", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const { module = "general", userIds = [], count = 20, expiresMinutes = 60 } = req.body || {};
    if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ error: "userIds required" });

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).json({ error: "org not found" });

    // prepare candidate pool: org-specific + global
    const match = { module: String(module).trim(), $or: [{ organization: org._id }, { organization: null }] };
    const pipeline = [{ $match: match }, { $sample: { size: Number(count) } }];
    let docs = await QuizQuestion.aggregate(pipeline).allowDiskUse(true);

    // fallback if pool smaller
    if (!docs || docs.length < count) {
      docs = await QuizQuestion.aggregate([{ $match: { module: String(module).trim(), $or: [{ organization: org._id }, { organization: null }] } }, { $sample: { size: Number(count) } }]).allowDiskUse(true);
    }
    if (!docs || !docs.length) return res.status(404).json({ error: "no questions available for that module" });

    // prepare questionIds and shuffle choices per question for each user
    const assigned = [];
    for (const uId of userIds) {
      try {
        // build choicesOrder per question
        const questionIds = [];
        const choicesOrder = [];
        const series = []; // not stored here but could be used if returning details
        for (const q of docs) {
          questionIds.push(q._id);
          const n = (q.choices || []).length;
          const indices = Array.from({ length: n }, (_, i) => i);
          // shuffle
          for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
          }
          choicesOrder.push(indices);
        }
        const examId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + (Number(expiresMinutes) * 60 * 1000));
        await ExamInstance.create({ examId, org: org._id, module: module, user: mongoose.Types.ObjectId(uId), questionIds, choicesOrder, expiresAt, createdByIp: req.ip });

        // create a starter Attempt (if your Attempt model exists)
        if (Attempt) {
          await Attempt.create({ userId: mongoose.Types.ObjectId(uId), organization: org._id, module: module, questionIds, startedAt: new Date(), maxScore: questionIds.length });
        }

        const url = `${BASE_URL.replace(/\/$/, "")}/org/${org.slug}/quiz?examId=${examId}`;
        assigned.push({ userId: uId, examId, url });
      } catch (e) {
        console.warn("[assign-quiz] user assign failed", uId, e && e.stack || e);
      }
    }

    return res.json({ ok: true, assigned });
  } catch (err) {
    console.error("[assign quiz] error:", err && (err.stack || err));
    return res.status(500).json({ error: "assign failed" });
  }
});

/**
 * REPORT: Export attempts CSV for org/module
 * GET /admin/orgs/:slug/reports/attempts.csv?module=xxx
 * Returns CSV with columns: userId, userEmail, module, score, maxScore, passed, startedAt, finishedAt
 */
router.get("/admin/orgs/:slug/reports/attempts.csv", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const module = String(req.query.module || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    // sound assumption: Attempt model stores organization, module, userId, score, maxScore, passed, timestamps
    const filter = { organization: org._id };
    if (module) filter.module = module;
    const attempts = await Attempt.find(filter).populate("userId").sort({ createdAt: -1 }).lean();

    // build CSV
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="attempts_${org.slug}_${module || 'all'}.csv"`);

    // header
    res.write("userId,userEmail,module,score,maxScore,passed,startedAt,finishedAt\n");
    for (const a of attempts) {
      const uid = a.userId ? String(a.userId._id) : (a.userId || "");
      const email = a.userId ? (a.userId.email || "") : "";
      const started = a.startedAt ? new Date(a.startedAt).toISOString() : "";
      const finished = a.finishedAt ? new Date(a.finishedAt).toISOString() : "";
      res.write(`${uid},${email},${a.module || ""},${a.score || 0},${a.maxScore || 0},${a.passed ? "1" : "0"},${started},${finished}\n`);
    }
    res.end();
  } catch (err) {
    console.error("[reports csv] error:", err && (err.stack || err));
    return res.status(500).send("failed");
  }
});

/**
 * ORG DASHBOARD for employees and managers
 * GET /org/:slug/dashboard  (kept simple)
 */
router.get("/org/:slug/dashboard", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).send("You are not a member of this organization");

    const modules = await OrgModule.find({ org: org._id }).lean();

    return res.render("org/dashboard", { org, membership, modules, user: req.user });
  } catch (err) {
    console.error("[org dashboard] error:", err && (err.stack || err));
    return res.status(500).send("failed");
  }
});

export default router;
