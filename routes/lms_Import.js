// routes/lms_import.js
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import crypto from "crypto";


import { ensureAuth } from "../middleware/authGuard.js";

import Question from "../models/question.js";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";

const router = Router();

/* ------------------------------------------------------------------ */
/*  Multer                                                            */
/* ------------------------------------------------------------------ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 12 },
});

/* ------------------------------------------------------------------ */
/*  Admin check                                                       */
/* ------------------------------------------------------------------ */
function ensureAdmin(req, res, next) {
  const email = (req.user?.email || "").toLowerCase();
  const admins = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!admins.has(email)) return res.status(403).send("Admins only");
  next();
}

/* ------------------------------------------------------------------ */
/*  GET import page                                                   */
/* ------------------------------------------------------------------ */
router.get("/lms/import", ensureAuth, ensureAdmin, async (req, res) => {
  const organizations = await Organization.find()
    .select("_id name slug")
    .sort({ name: 1 })
    .lean();

  res.render("admin/lms_import", {
    title: "Import LMS Questions",
    user: req.user,
    organizations,
  });
});

/* ------------------------------------------------------------------ */
/*  POST import + ASSIGN (PASSAGE-STYLE)                              */
/* ------------------------------------------------------------------ */
router.post(
  "/lms/import",
  ensureAuth,
  ensureAdmin,
  upload.any(),
  async (req, res) => {
    try {
      let content = "";

      if (req.files?.length) {
        content = req.files[0].buffer.toString("utf8");
      } else if (req.body.text) {
        content = String(req.body.text);
      }

      if (!content.trim()) {
        return res.status(400).send("No content provided");
      }

      const saveToDb = req.body.save === "1" || req.body.save === "on";
      const moduleKey = String(req.body.module || "general").toLowerCase();

      const orgId =
        req.body.orgId && mongoose.isValidObjectId(req.body.orgId)
          ? new mongoose.Types.ObjectId(req.body.orgId)
          : null;

      if (!saveToDb || !orgId) {
        return res.send("Preview completed (not saved)");
      }

      /* ✅ NEW: read quiz title safely */
      const quizTitle =
        typeof req.body.quizTitle === "string" && req.body.quizTitle.trim()
          ? req.body.quizTitle.trim()
          : `${moduleKey} Imported Quiz`;

      /* ---------------- Parse ---------------- */
      const parsed = parseQuestionsFromText(content);
      if (!parsed.length) {
        return res.status(400).send("No valid questions parsed");
      }

      /* ---------------- Insert CHILD questions ---------------- */
      const childDocs = parsed.map(q => ({
        text: q.text,
        choices: q.choices.map(c => ({ text: c })),
        correctIndex: q.answerIndex,
        organization: orgId,
        module: moduleKey,
        source: "import",
        createdAt: new Date(),
      }));

      const insertedChildren = await Question.insertMany(childDocs);
      const childIds = insertedChildren.map(q => q._id);

      /* ---------------- Create PARENT comprehension ---------------- */
      const parent = await Question.create({
        text: quizTitle,              // ✅ FIXED (was hardcoded)
        type: "comprehension",
        passage: "Imported LMS quiz",
        questionIds: childIds,
        organization: orgId,
        module: moduleKey,
        source: "import",
        createdAt: new Date(),
      });

      /* ---------------- Assign EXACTLY like passage ---------------- */
      const members = await OrgMembership.find({
        org: orgId,
        role: { $in: ["employee", "manager", "admin"] },
      }).lean();

      for (const m of members) {
        const questionIds = [];
        const choicesOrder = [];

        // parent marker (CRITICAL)
        questionIds.push(`parent:${parent._id}`);
        choicesOrder.push([]);

        for (const q of insertedChildren) {
          questionIds.push(String(q._id));

          const indices = Array.from(
            { length: q.choices.length },
            (_, i) => i
          );
          for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
          }
          choicesOrder.push(indices);
        }

        const examId = crypto.randomUUID();

        await ExamInstance.create({
          examId,
          org: orgId,
          module: moduleKey,
          user: mongoose.Types.ObjectId(m.user),
          questionIds,
          choicesOrder,
          createdAt: new Date(),
          createdBy: "import",
        });

        await Attempt.create({
          userId: mongoose.Types.ObjectId(m.user),
          organization: orgId,
          module: moduleKey,
          questionIds,
          startedAt: new Date(),
          maxScore: childIds.length,
        });
      }

      return res.send(
        `✅ Imported ${childIds.length} questions and assigned to ${members.length} users`
      );
    } catch (err) {
      console.error("[LMS IMPORT] error:", err && err.stack);
      return res.status(500).send("Import failed");
    }
  }
);


/* ------------------------------------------------------------------ */
/*  Parser                                                           */
/* ------------------------------------------------------------------ */
function parseQuestionsFromText(raw) {
  const blocks = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n{2,}/)
    .map(b => b.trim())
    .filter(Boolean);

  const parsed = [];

  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;

    const question = lines[0];
    const choices = [];
    let answerIndex = -1;

    for (const line of lines.slice(1)) {
      const m = line.match(/^([a-dA-D])[.)]\s*(.+)$/);
      if (m) choices.push(m[2]);

      const a = line.match(/Correct Answer\s*[:\-]?\s*([a-dA-D])/i);
      if (a) answerIndex = "abcd".indexOf(a[1].toLowerCase());
    }

    if (choices.length >= 2 && answerIndex >= 0) {
      parsed.push({ text: question, choices, answerIndex });
    }
  }

  return parsed;
}

export default router;
