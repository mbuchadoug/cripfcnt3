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

/* ------------------------------------------------------------------ */
/*  Admin check – uses ADMIN_EMAILS env (comma separated)              */
/* ------------------------------------------------------------------ */
function ensureAdminEmails(req, res, next) {
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!req.user || !req.user.email) {
    return res.status(403).send("Admins only");
  }
  if (!adminEmails.includes(req.user.email.toLowerCase())) {
    return res.status(403).send("Admins only");
  }
  next();
}

/* ------------------------------------------------------------------ */
/*  Nodemailer transporter helper                                     */
/* ------------------------------------------------------------------ */

let cachedTransporter = null;

function createTransporterFromEnv() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure =
    String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";

  const hasRequired = !!(host && user && pass);

  console.log("[invite email] env snapshot:", {
    SMTP_HOST: host,
    SMTP_USER: user,
    SMTP_HAS_PASS: !!pass,
    SMTP_PORT: port,
    SMTP_SECURE: secure,
    BASE_URL: process.env.BASE_URL,
  });

  if (!hasRequired) {
    console.warn(
      "[invite email] SMTP env incomplete; host/user/pass are required"
    );
    return null;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure, // true for 465 (SSL), false for 587 (STARTTLS)
    auth: { user, pass },
  });

  console.log(
    "[invite email] transporter created",
    `host=${host} port=${port} secure=${secure}`
  );
  return transporter;
}

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = createTransporterFromEnv();
  return cachedTransporter;
}

/* ------------------------------------------------------------------ */
/*  ADMIN: Send invite                                                */
/*  POST /admin/orgs/:slug/invite                                     */
/* ------------------------------------------------------------------ */

router.post(
  "/admin/orgs/:slug/invite",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim();
      const email = String(req.body.email || "").trim().toLowerCase();
      const role = String(req.body.role || "employee");

      if (!email) return res.status(400).json({ error: "email required" });

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ error: "org not found" });

      const token = crypto.randomBytes(16).toString("hex");
      const invite = await OrgInvite.create({
        orgId: org._id,
        email,
        token,
        role,
      });

      const baseUrl = (process.env.BASE_URL || "").replace(/\/$/, "");
      const transporter = getTransporter();

      if (!transporter || !baseUrl) {
        console.warn(
          "[invite email] transporter not available or BASE_URL missing; invite email skipped",
          { hasTransporter: !!transporter, baseUrl }
        );
        return res.json({ ok: true, token: invite.token });
      }

      const inviteUrl = `${baseUrl}/org/join/${token}`;

      try {
        const info = await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: email,
          subject: `Invite to join ${org.name}`,
          text: `You've been invited to join ${org.name}. Click to accept: ${inviteUrl}`,
          html: `
            <p>You've been invited to join <strong>${org.name}</strong>.</p>
            <p><a href="${inviteUrl}">Click here to accept the invite</a></p>
          `,
        });

        console.log("[invite email] sent:", info.messageId);
      } catch (e) {
        console.error("[invite email] send failed:", e && (e.stack || e));
      }

      return res.json({ ok: true, token: invite.token });
    } catch (err) {
      console.error("[admin invite] error:", err && (err.stack || err));
      return res.status(500).json({ error: "invite failed" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  ADMIN: Manage org page                                            */
/*  GET /admin/orgs/:slug/manage                                      */
/* ------------------------------------------------------------------ */

router.get(
  "/admin/orgs/:slug/manage",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "");
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      const invites = await OrgInvite.find({ orgId: org._id })
        .sort({ createdAt: -1 })
        .lean();
      const memberships = await OrgMembership.find({ org: org._id })
        .populate("user")
        .lean();
      const modules = await OrgModule.find({ org: org._id }).lean();

      return res.render("admin/org_manage", {
        org,
        invites,
        memberships,
        modules,
      });
    } catch (err) {
      console.error("[admin org manage] error:", err && (err.stack || err));
      return res.status(500).send("failed");
    }
  }
);

/* ------------------------------------------------------------------ */
/*  PUBLIC: Join via invite token (must be logged in)                 */
/*  GET /org/join/:token                                              */
/* ------------------------------------------------------------------ */

router.get("/org/join/:token", ensureAuth, async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!token) return res.status(400).send("token required");

    const invite = await OrgInvite.findOne({ token, used: false }).lean();
    if (!invite) return res.status(404).send("invite not found or used");

    await OrgMembership.findOneAndUpdate(
      { org: invite.orgId, user: req.user._id },
      { $set: { role: invite.role, joinedAt: new Date() } },
      { upsert: true }
    );

    await OrgInvite.updateOne(
      { _id: invite._id },
      { $set: { used: true } }
    );

    const org = await Organization.findById(invite.orgId).lean();
    return res.redirect(`/org/${org.slug}/dashboard`);
  } catch (err) {
    console.error("[org/join] error:", err && (err.stack || err));
    return res.status(500).send("join failed");
  }
});

/* ------------------------------------------------------------------ */
/*  ADMIN: Member actions (promote/demote/remove)                     */
/*  POST /admin/orgs/:slug/members/:userId                            */
/* ------------------------------------------------------------------ */

router.post(
  "/admin/orgs/:slug/members/:userId",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
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
        await OrgMembership.findOneAndUpdate(
          { org: org._id, user: userId },
          { $set: { role } },
          { upsert: true }
        );
        return res.json({ ok: true, action: "promoted", role });
      } else if (action === "demote") {
        await OrgMembership.findOneAndUpdate(
          { org: org._id, user: userId },
          { $set: { role: "employee" } }
        );
        return res.json({ ok: true, action: "demoted" });
      } else {
        return res.status(400).json({ error: "invalid action" });
      }
    } catch (err) {
      console.error("[admin member action] error:", err && (err.stack || err));
      return res.status(500).json({ error: "failed" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  ADMIN: Assign quiz to employees                                   */
/*  POST /admin/orgs/:slug/assign-quiz                                */
/* ------------------------------------------------------------------ */

router.post(
  "/admin/orgs/:slug/assign-quiz",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "");
      let { module = "general", userIds = [], count = 20, expiresMinutes = 60 } =
        req.body || {};

      if (!Array.isArray(userIds) || !userIds.length) {
        return res.status(400).json({ error: "userIds required" });
      }

      const moduleKey = String(module).trim().toLowerCase();

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ error: "org not found" });

      const match = {
        $or: [{ organization: org._id }, { organization: null }],
        module: { $regex: new RegExp(`^${moduleKey}$`, "i") },
      };

      const totalAvailable = await QuizQuestion.countDocuments(match);
      console.log(
        "[assign quiz] available questions:",
        totalAvailable,
        "for module=",
        moduleKey,
        "org=",
        org._id.toString()
      );

      if (!totalAvailable) {
        return res
          .status(404)
          .json({ error: "no questions available for that module" });
      }

      count = Math.min(Number(count) || 1, totalAvailable);

      const pipeline = [{ $match: match }, { $sample: { size: count } }];
      const docs = await QuizQuestion.aggregate(pipeline).allowDiskUse(true);

      if (!docs || !docs.length) {
        return res
          .status(404)
          .json({ error: "no questions returned from sampling" });
      }

      const assigned = [];
      const baseUrl = (process.env.BASE_URL || "").replace(/\/$/, "");

      for (const uId of userIds) {
        try {
          const questionIds = [];
          const choicesOrder = [];

          for (const q of docs) {
            questionIds.push(q._id);
            const n = (q.choices || []).length;
            const indices = Array.from({ length: n }, (_, i) => i);
            for (let i = indices.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [indices[i], indices[j]] = [indices[j], indices[i]];
            }
            choicesOrder.push(indices);
          }

          const examId = crypto.randomUUID();
          const expiresAt = new Date(
            Date.now() + Number(expiresMinutes) * 60 * 1000
          );

          await ExamInstance.create({
            examId,
            org: org._id,
            module: moduleKey,
            user: mongoose.Types.ObjectId(uId),
            questionIds,
            choicesOrder,
            expiresAt,
            createdAt: new Date(),
            createdByIp: req.ip,
          });

          if (Attempt) {
            await Attempt.create({
              userId: mongoose.Types.ObjectId(uId),
              organization: org._id,
              module: moduleKey,
              questionIds,
              startedAt: new Date(),
              maxScore: questionIds.length,
            });
          }

          const url = `${baseUrl}/org/${org.slug}/quiz?examId=${examId}&module=${encodeURIComponent(
            moduleKey
          )}`;
          assigned.push({ userId: uId, examId, url });
        } catch (e) {
          console.warn(
            "[assign-quiz] user assign failed",
            uId,
            e && (e.stack || e)
          );
        }
      }

      return res.json({ ok: true, assigned, countUsed: count });
    } catch (err) {
      console.error("[assign quiz] error:", err && (err.stack || err));
      return res.status(500).json({ error: "assign failed" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  ADMIN: Export attempts CSV                                        */
/*  GET /admin/orgs/:slug/reports/attempts.csv?module=xxx             */
/* ------------------------------------------------------------------ */

router.get(
  "/admin/orgs/:slug/reports/attempts.csv",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "");
      const module = String(req.query.module || "");
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      const filter = { organization: org._id };
      if (module) filter.module = module;

      const attempts = await Attempt.find(filter)
        .populate("userId")
        .sort({ createdAt: -1 })
        .lean();

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="attempts_${org.slug}_${module || "all"}.csv"`
      );

      res.write(
        "userId,userEmail,module,score,maxScore,passed,startedAt,finishedAt\n"
      );

      for (const a of attempts) {
        const uid = a.userId ? String(a.userId._id) : a.userId || "";
        const email = a.userId ? a.userId.email || "" : "";
        const started = a.startedAt
          ? new Date(a.startedAt).toISOString()
          : "";
        const finished = a.finishedAt
          ? new Date(a.finishedAt).toISOString()
          : "";
        res.write(
          `${uid},${email},${a.module || ""},${a.score || 0},${
            a.maxScore || 0
          },${a.passed ? "1" : "0"},${started},${finished}\n`
        );
      }
      res.end();
    } catch (err) {
      console.error("[reports csv] error:", err && (err.stack || err));
      return res.status(500).send("failed");
    }
  }
);

/* ------------------------------------------------------------------ */
/*  ORG DASHBOARD (employees/managers)                                */
/*  GET /org/:slug/dashboard                                          */
/* ------------------------------------------------------------------ */

router.get("/org/:slug/dashboard", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const membership = await OrgMembership.findOne({
      org: org._id,
      user: req.user._id,
    }).lean();
    if (!membership) {
      return res.status(403).send("You are not a member of this organization");
    }

    const modules = await OrgModule.find({ org: org._id }).lean();

    const exams = await ExamInstance.find({
      org: org._id,
      user: req.user._id,
    })
      .sort({ createdAt: -1 })
      .lean();

    const quizzesByModule = {};
    const now = new Date();

    for (const ex of exams) {
      const key = ex.module || "general";
      if (!quizzesByModule[key]) quizzesByModule[key] = [];

      let status = "pending";
      if (ex.finishedAt) status = "completed";
      else if (ex.expiresAt && ex.expiresAt < now) status = "expired";

      // 👇 Org quiz link: 20-question UI, includes module for label
      const openUrl = `/org/${org.slug}/quiz?examId=${encodeURIComponent(
        ex.examId
      )}&module=${encodeURIComponent(ex.module || "Responsibility")}`;

      quizzesByModule[key].push({
        examId: ex.examId,
        module: ex.module,
        createdAt: ex.createdAt,
        expiresAt: ex.expiresAt,
        finishedAt: ex.finishedAt,
        status,
        openUrl,
      });
    }

    return res.render("org/dashboard", {
      org,
      membership,
      modules,
      user: req.user,
      quizzesByModule,
    });
  } catch (err) {
    console.error("[org dashboard] error:", err && (err.stack || err));
    return res.status(500).send("failed");
  }
});

/* ------------------------------------------------------------------ */
/*  ORG: View a single module's learning material                     */
/*  GET /org/:slug/modules/:moduleSlug                                */
/* ------------------------------------------------------------------ */

router.get("/org/:slug/modules/:moduleSlug", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const moduleSlug = String(req.params.moduleSlug || "");

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const membership = await OrgMembership.findOne({
      org: org._id,
      user: req.user._id,
    }).lean();
    if (!membership)
      return res
        .status(403)
        .send("You are not a member of this organization");

    const moduleDoc = await OrgModule.findOne({
      org: org._id,
      slug: moduleSlug,
    }).lean();
    if (!moduleDoc) return res.status(404).send("module not found");

    return res.render("org/module_detail", {
      org,
      membership,
      module: moduleDoc,
      user: req.user,
    });
  } catch (err) {
    console.error("[org module detail] error:", err && (err.stack || err));
    return res.status(500).send("failed");
  }
});

/* ------------------------------------------------------------------ */
/*  ORG QUIZ VIEW (20-question LMS UI for orgs)                       */
/*  GET /org/:slug/quiz                                               */
/* ------------------------------------------------------------------ */

router.get("/org/:slug/quiz", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const moduleNameRaw = String(req.query.module || "Responsibility").trim();

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const membership = await OrgMembership.findOne({
      org: org._id,
      user: req.user._id,
    }).lean();
    if (!membership) {
      return res.status(403).send("You are not a member of this organization");
    }

    return res.render("lms/quiz", {
      user: req.user,
      quizCount: 20,                 // 20-question quiz for orgs
      module: moduleNameRaw,         // label used in the view
      orgSlug: org.slug,             // so the HBS can show org name
    });
  } catch (err) {
    console.error("[org quiz] error:", err && (err.stack || err));
    return res.status(500).send("failed");
  }
});

export default router;
