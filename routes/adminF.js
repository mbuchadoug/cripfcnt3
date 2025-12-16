// routes/admin.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import User from "../models/user.js";
import Organization from "../models/organization.js";
import QuizQuestion from "../models/quizQuestionF.js";
import { ensureAuth } from "../middleware/authGuard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = Router();
console.log("🔥 admin routes loaded");

// multer
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// admin check helper
function getAdminSet() {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function ensureAdmin(req, res, next) {
  const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
  const ADMIN_SET = getAdminSet();
  if (!email || !ADMIN_SET.has(email)) {
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(403).send("<h3>Forbidden — admin only</h3>");
    }
    return res.status(403).json({ error: "Forbidden — admin only" });
  }
  next();
}

// simple parser (lightweight) — accepts same blocks as before but simpler
function parseQuestionBlocks(raw) {
  if (!raw || typeof raw !== "string") return [];
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const blocks = normalized.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const parsed = [];
  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    // question line
    let qline = lines[0].replace(/^\d+\.\s*/, "").trim();
    // choices a)-d)
    const choices = [];
    for (const l of lines.slice(1)) {
      const m = l.match(/^[a-dA-D][\.\)]\s*(.+)$/);
      if (m) choices.push(m[1].trim());
    }
    if (choices.length < 2) continue;
    // find answer
    const footer = lines.find(l => /Correct Answer:/i.test(l) || /✅ Correct Answer:/i.test(l));
    let answerIndex = 0;
    if (footer) {
      const m = footer.match(/Correct Answer[:\s\-]*([a-dA-D])/i);
      if (m) answerIndex = "abcd".indexOf(m[1].toLowerCase());
      else {
        const text = footer.replace(/Correct Answer[:\s\-]*/i, "").trim();
        const found = choices.findIndex(c => c.toLowerCase().startsWith(text.toLowerCase()) || c.toLowerCase() === text.toLowerCase());
        if (found >= 0) answerIndex = found;
      }
    }
    parsed.push({ text: qline, choices, correctIndex: answerIndex, rawBlock: block });
  }
  return parsed;
}

// GET import form
router.get("/lms/import", ensureAuth, ensureAdmin, async (req, res) => {
  const orgs = await Organization.find().lean().select("name slug");
  return res.render("admin/lms_import", { title: "Import LMS Questions", orgs, user: req.user });
});

// POST import (file or textarea)
router.post("/lms/import", ensureAuth, ensureAdmin, upload.single("file"), async (req, res) => {
  try {
    let content = "";
    if (req.file && req.file.buffer && req.file.buffer.length) {
      content = req.file.buffer.toString("utf8");
    } else if (req.body && typeof req.body.text === "string" && req.body.text.trim().length) {
      content = req.body.text;
    }
    if (!content || !content.trim()) {
      return res.status(400).send("No content provided");
    }

    // parse
    const blocks = parseQuestionBlocks(content);
    // org + module from form
    const orgSlug = req.body.organization || "";
    const moduleName = req.body.module || "general";
    let org = null;
    if (orgSlug) org = await Organization.findOne({ slug: orgSlug });

    // prepare insert
    const toInsert = blocks.map(b => {
      const choices = (b.choices || []).slice(0, 4).map(c => String(c).trim());
      let ci = (typeof b.correctIndex === "number") ? b.correctIndex : 0;
      if (ci < 0 || ci >= choices.length) ci = 0;
      return {
        organization: org ? org._id : null,
        module: moduleName,
        text: b.text || "Question",
        choices,
        answerIndex: ci,
        tags: ["import"],
        source: req.user ? `admin:${req.user.email || req.user._id}` : "admin",
        createdBy: req.user ? req.user._id : null
      };
    });

    let insertedCount = 0;
    if (toInsert.length) {
      const resInsert = await QuizQuestion.insertMany(toInsert, { ordered: false });
      insertedCount = resInsert.length || 0;
    }

    return res.render("admin/lms_import", { title: "Import results", result: { parsed: blocks.length, inserted: insertedCount }, orgs: await Organization.find().lean().select("name slug"), user: req.user });
  } catch (e) {
    console.error("[admin/lms/import] error:", e && e.message);
    return res.status(500).send("Import failed: " + (e && e.message));
  }
});

export default router;
