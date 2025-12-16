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

// helper: check platform admin boolean
function isPlatformAdmin(req) {
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!(req.user && req.user.email && adminEmails.includes(req.user.email.toLowerCase()));
}

/* ------------------------------------------------------------------ */
/*  Helper: allow platform admin OR org manager (role)                 */
/* ------------------------------------------------------------------ */
async function allowPlatformAdminOrOrgManager(req, res, next) {
  try {
    if (isPlatformAdmin(req)) return next();

    // not platform admin -> check org membership role
    const slug = String(req.params.slug || "").trim();
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).send("Admins only (org membership required)");

    const role = String(membership.role || "").toLowerCase();
    if (role === "manager" || role === "admin") return next();

    return res.status(403).send("Admins only (insufficient role)");
  } catch (e) {
    console.error("[allowPlatformAdminOrOrgManager] error:", e && (e.stack || e));
    return res.status(500).send("server error");
  }
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
/*  ADMIN: View attempts list (platform admins OR org managers)       */
/*  GET /admin/orgs/:slug/attempts                                    */
/* ------------------------------------------------------------------ */
router.get(
  "/admin/orgs/:slug/attempts",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim();
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      // optional module filter
      const moduleFilter = req.query.module ? String(req.query.module).trim() : null;

      const filter = { organization: org._id };
      if (moduleFilter) filter.module = moduleFilter;

      const attempts = await Attempt.find(filter)
        .populate("userId")
        .sort({ createdAt: -1 })
        .lean();

      // shape some display fields
      const rows = attempts.map(a => ({
        _id: a._id,
        userName: a.userId ? (a.userId.displayName || a.userId.name || a.userId.email || "") : "",
        userEmail: a.userId ? a.userId.email || "" : "",
        module: a.module || "",
        score: a.score || 0,
        maxScore: a.maxScore || 0,
        passed: !!a.passed,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
        createdAt: a.createdAt
      }));

      // try render a template (admin/org_attempts) if available, else fallback to JSON
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.render("admin/org_attempts", { org, attempts: rows, moduleFilter: moduleFilter || "" });
      }
      return res.json({ org: org.slug, attempts: rows });
    } catch (e) {
      console.error("[admin attempts list] error:", e && (e.stack || e));
      return res.status(500).send("failed to load attempts");
    }
  }
);

/* ------------------------------------------------------------------ */
/*  ADMIN: View single attempt detail                                 */
/*  GET /admin/orgs/:slug/attempts/:attemptId                         */
/* ------------------------------------------------------------------ */
router.get(
  "/admin/orgs/:slug/attempts/:attemptId",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim();
      const attemptId = String(req.params.attemptId || "").trim();

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      const attempt = await Attempt.findById(attemptId).lean();
      if (!attempt) return res.status(404).send("attempt not found");

      // load questions referenced in attempt (if available)
      const qIds = Array.isArray(attempt.questionIds) ? attempt.questionIds.map(String) : [];
      let qDocs = [];
      if (qIds.length) {
        qDocs = await QuizQuestion.find({ _id: { $in: qIds } }).lean();
      }

      const qById = {};
      for (const q of qDocs) qById[String(q._id)] = q;

      // map answers array into lookup
      const answersLookup = {};
      if (Array.isArray(attempt.answers)) {
        for (const a of attempt.answers) {
          if (!a || !a.questionId) continue;
          answersLookup[String(a.questionId)] = (typeof a.choiceIndex === "number") ? a.choiceIndex : null;
        }
      }

      // Build details array preserving order of questionIds in attempt
      const details = [];
      for (const qid of qIds) {
        const q = qById[qid] || null;
        const yourIndex = answersLookup[qid] !== undefined ? answersLookup[qid] : null;

        let correctIndex = null;
        if (q) {
          if (typeof q.correctIndex === "number") correctIndex = q.correctIndex;
          else if (typeof q.answerIndex === "number") correctIndex = q.answerIndex;
          else if (typeof q.correct === "number") correctIndex = q.correct;
        }

        const choices = (q && Array.isArray(q.choices)) ? q.choices.map(c => (typeof c === "string" ? c : c.text || "")) : [];

        details.push({
          questionId: qid,
          text: q ? q.text : "(question not in DB)",
          choices,
          yourIndex,
          correctIndex,
          correct: (correctIndex !== null && yourIndex !== null) ? (correctIndex === yourIndex) : null
        });
      }

      // attempt user info (populate if needed)
      let userInfo = null;
      if (attempt.userId) {
        try {
          const u = await User.findById(attempt.userId).lean();
          if (u) userInfo = { _id: u._id, name: u.displayName || u.name || "", email: u.email || "" };
        } catch (e) { /* ignore */ }
      }

      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.render("admin/org_attempt_detail", {
          org,
          attempt,
          user: userInfo,
          details
        });
      }

      return res.json({ attemptId: attempt._id, org: org.slug, user: userInfo, score: attempt.score, maxScore: attempt.maxScore, details });
    } catch (e) {
      console.error("[admin attempt detail] error:", e && (e.stack || e));
      return res.status(500).send("failed to load attempt details");
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
        await OrgMembership.deleteOne({ org: org._1d, user: userId });
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
/*  (kept unchanged except minor style)                               */
/* ------------------------------------------------------------------ */

// (Keep your existing assign-quiz code here — I left it unchanged in your original file.)
// For brevity in this file I will reuse the code block you already had above in your original file.
// If you want me to paste the full assign-quiz implementation here too, tell me and I'll include it exactly as before.

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

    // All modules for this org
    const modules = await OrgModule.find({ org: org._id }).lean();

    // All quiz instances assigned to THIS user in THIS org
    const exams = await ExamInstance.find({
      org: org._id,
      user: req.user._id,
    })
      .sort({ createdAt: -1 })
      .lean();

    // Group quizzes by module slug
    const quizzesByModule = {};
    const now = new Date();

    for (const ex of exams) {
      const key = ex.module || "general";
      if (!quizzesByModule[key]) quizzesByModule[key] = [];

      let status = "pending";
      if (ex.finishedAt) status = "completed";
      else if (ex.expiresAt && ex.expiresAt < now) status = "expired";

      const moduleKey = (ex.module || "responsibility").toLowerCase();
      const moduleLabel =
        moduleKey.charAt(0).toUpperCase() + moduleKey.slice(1);

      // Org quiz: 20 questions, filtered by module + org
      const openUrl = `/lms/quiz?module=${encodeURIComponent(
        moduleLabel
      )}&org=${encodeURIComponent(org.slug)}`;

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

    // compute isAdmin for template: platform admin OR org manager/admin
    const platformAdmin = isPlatformAdmin(req);
    const orgRole = String(membership.role || "").toLowerCase();
    const isOrgManager = orgRole === "manager" || orgRole === "admin";
    const isAdmin = !!(platformAdmin || isOrgManager);

    return res.render("org/dashboard", {
      org,
      membership,
      modules,
      user: req.user,
      quizzesByModule,
      isAdmin
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
/*  Member-facing quiz launcher for an org                             */
/*  GET /org/:slug/quiz?examId=...                                     */
/* ------------------------------------------------------------------ */

router.get("/org/:slug/quiz", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const examId = String(req.query.examId || "");

    if (!examId) return res.status(400).send("Missing examId");

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const membership = await OrgMembership.findOne({
      org: org._id,
      user: req.user._id,
    }).lean();
    if (!membership) {
      return res.status(403).send("You are not a member of this organization");
    }

    // Use existing LMS quiz UI
    return res.redirect(`/lms/quiz?examId=${encodeURIComponent(examId)}`);
  } catch (err) {
    console.error("[org quiz] error:", err && (err.stack || err));
    return res.status(500).send("failed");
  }
});

/* ------------------------------------------------------------------ */
/*  ORG QUIZ: employees/managers take module quiz (20 questions)       */
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

    const moduleKey = moduleNameRaw.toLowerCase();

    return res.render("lms/quiz", {
      user: req.user,
      quizCount: 20,
      moduleLabel: `${moduleNameRaw} | ${org.slug} Quiz`,
      moduleKey,
      orgSlug: org.slug,
    });
  } catch (err) {
    console.error("[org quiz] error:", err && (err.stack || err));
    return res.status(500).send("failed");
  }
});


router.post(
  "/admin/orgs/:slug/assign-quiz",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "");
      let { module = "general", userIds = [], count = 20, expiresMinutes = 60 } =
        req.body || {};

      // userIds from <select multiple> come as a flat array of strings
      if (!Array.isArray(userIds) || !userIds.length) {
        return res.status(400).json({ error: "userIds required" });
      }

      // normalize module to lowercase
      const moduleKey = String(module).trim().toLowerCase();

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ error: "org not found" });

      // case-insensitive match on module + org/global questions
      const match = {
        $or: [{ organization: org._id }, { organization: null }],
        module: { $regex: new RegExp(`^${moduleKey}$`, "i") },
      };

      // how many questions exist for debugging
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

      // we cannot take more than we actually have
      count = Math.min(Number(count) || 1, totalAvailable);

      // sample `count` questions
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
            // shuffle choices
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

          const url = `${baseUrl}/org/${org.slug}/quiz?examId=${examId}`;
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


router.get(
  "/admin/orgs/:slug/modules",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = req.params.slug;
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("Org not found");

      const modules = await OrgModule.find({ org: org._id }).lean();

      res.render("admin/org_modules", {
        org,
        modules,
      });
    } catch (err) {
      console.error("Load modules error:", err);
      res.status(500).send("Failed to load modules");
    }
  }
);

router.post(
  "/admin/orgs/:slug/modules",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const orgSlug = req.params.slug;
      const { slug, title, description } = req.body;

      if (!slug || !title) {
        return res.status(400).send("Module slug and title are required");
      }

      const org = await Organization.findOne({ slug: orgSlug });
      if (!org) return res.status(404).send("Org not found");

      await OrgModule.findOneAndUpdate(
        { org: org._id, slug },
        { title, description },
        { upsert: true, new: true }
      );

      res.redirect(`/admin/orgs/${orgSlug}/modules`);
    } catch (err) {
      if (err.code === 11000) {
        console.warn("[modules] duplicate org/slug ignored", err.keyValue);
        return res.redirect(`/admin/orgs/${req.params.slug}/modules?dup=1`);
      }

      console.error("Save module error:", err);
      res.status(500).send("Failed to save module");
    }
  }
);


// export default router
export default router;
