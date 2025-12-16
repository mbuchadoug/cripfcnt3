// routes/admin.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import User from "../models/user.js";
import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";
import { ensureAuth } from "../middleware/authGuard.js";




const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();
console.log("🔥 admin routes loaded");

// storage for multer (store in memory then write to disk)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// helper: admin set
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

// safeRender helper so res.render errors are captured
function safeRender(req, res, view, locals = {}) {
  try {
    return res.render(view, locals, (err, html) => {
      if (err) {
        console.error(`[safeRender] render error for view="${view}":`, err && (err.stack || err));
        if (req.headers.accept && req.headers.accept.includes("text/html")) {
          if (!res.headersSent) {
            return res.status(500).send(`<h3>Server error rendering ${view}</h3><pre>${String(err.message || err)}</pre>`);
          }
          return;
        }
        if (!res.headersSent) return res.status(500).json({ error: "Render failed", detail: String(err.message || err) });
        return;
      }
      if (!res.headersSent) return res.send(html);
    });
  } catch (e) {
    console.error(`[safeRender] synchronous render exception for view="${view}":`, e && (e.stack || e));
    if (!res.headersSent) {
      return res.status(500).send("Server render exception");
    }
  }
}

/**
 * Simple parser for the quiz text format.
 * Expects blocks separated by blank lines. Each block:
 *  <number>. Question text
 *  a) choice
 *  b) choice
 *  c) choice
 *  d) choice
 *  Correct Answer: b) ...
 *
 * Returns array of { text, choices: [{text}], correctIndex }
 */
function parseQuestionBlocks(raw) {
  if (!raw || typeof raw !== "string") return [];
  // normalize line endings
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // split on two or more newlines (blank line)
  const blocks = normalized.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const parsed = [];

  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;

    // strip leading numbering if present
    if (/^\d+\.\s*/.test(lines[0])) {
      lines[0] = lines[0].replace(/^\d+\.\s*/, "");
    }
    const questionText = lines[0];

    // find choices lines a) b) c) d)
    const choiceLines = lines.filter(l => /^[a-d]\)/i.test(l));
    const choices = choiceLines.map(cl => cl.replace(/^[a-d]\)\s*/i, "").trim());

    // find correct answer line
    const correctLine = lines.find(l => /Correct Answer:/i.test(l) || /✅ Correct Answer:/i.test(l));
    let correctIndex = null;
    if (correctLine) {
      const m = correctLine.match(/Correct Answer:\s*([a-d])\)?/i);
      if (m) {
        const letter = m[1].toLowerCase();
        correctIndex = { a:0,b:1,c:2,d:3 }[letter];
      } else {
        const textMatch = correctLine.replace(/Correct Answer:\s*/i, "").trim();
        const found = choices.findIndex(c => c.toLowerCase().startsWith(textMatch.toLowerCase()) || c.toLowerCase() === textMatch.toLowerCase());
        if (found >= 0) correctIndex = found;
      }
    }

    if (!questionText || choices.length === 0) continue;

    parsed.push({
      text: questionText,
      choices: choices.map(c => ({ text: c })),
      correctIndex: typeof correctIndex === "number" ? correctIndex : null,
      rawBlock: block
    });
  }
  return parsed;
}

// path to save fallback file so API can read it
const FALLBACK_PATH = "/mnt/data/responsibilityQuiz.txt";

// GET import page (render a simple importer)
router.get("/lms/import", ensureAuth, ensureAdmin, (req, res) => {
  return safeRender(req, res, "admin/lms_import", { title: "Import LMS Questions (paste)" });
});

/**
 * POST /admin/lms/import
 * Accepts:
 *   - file upload (field 'file')
 *   - or pasted text in textarea (field 'text')
 * If 'save' param present, attempt to save parsed questions to DB (Questions collection).
 */
router.post("/lms/import", ensureAuth, ensureAdmin, upload.single("file"), async (req, res) => {
  try {
    // prefer uploaded file -> fallback to textarea 'text'
    let content = "";

    if (req.file && req.file.buffer && req.file.buffer.length) {
      content = req.file.buffer.toString("utf8");
    } else if (req.body && typeof req.body.text === "string" && req.body.text.trim().length) {
      content = req.body.text;
    }

    if (!content || !content.trim()) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(400).send("Import failed: No text provided. Paste your questions or upload a .txt file and click Import.");
      }
      return res.status(400).json({ error: "No text provided" });
    }

    // Save fallback file to disk so API /mnt/data reads it
    try {
      const dir = path.dirname(FALLBACK_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(FALLBACK_PATH, content, { encoding: "utf8" });
      console.log(`[admin/lms/import] saved fallback quiz file to ${FALLBACK_PATH}`);
    } catch (err) {
      console.error("[admin/lms/import] failed to write fallback file:", err && (err.stack || err));
    }

    // parse blocks
    const blocks = parseQuestionBlocks(content);
    console.log(`[admin/lms/import] parsed ${blocks.length} question blocks`);

    // If admin requested to "save" to DB, attempt to insert into Question collection
    const saveToDb = req.body && (req.body.save === "1" || req.body.save === "true" || req.body.save === "on");

    let inserted = 0;
    let dbSkipped = false;
    let dbErr = null;

    if (saveToDb && blocks.length) {
      try {
        // import Question model if present (best-effort)
        let Question;
        try {
          Question = (await import("../models/question.js")).default;
        } catch (e) {
          try {
            Question = (await import("../models/question/index.js")).default;
          } catch (e2) {
            Question = null;
          }
        }

        if (!Question) {
          dbSkipped = true;
          console.warn("[admin/lms/import] Question model not found — skipping DB insert");
        } else {
          // map parsed blocks into the DB schema shape (best effort)
          const toInsert = blocks.map(b => ({
            text: b.text,
            // store choices as array of objects or strings depending on your schema
            choices: b.choices.map(c => (typeof c === "string" ? { text: c } : (c.text ? { text: c.text } : c))),
            correctIndex: typeof b.correctIndex === "number" ? b.correctIndex : null,
            tags: ["responsibility"],
            source: "import",
            createdAt: new Date()
          }));

          const result = await Question.insertMany(toInsert);
          inserted = result.length || 0;
        }
      } catch (err) {
        console.error("[admin/lms/import] DB insert error:", err && (err.stack || err));
        dbErr = String(err.message || err);
      }
    }

    // Render preview page (if HTML) with summary
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return safeRender(req, res, "admin/lms_import_summary", {
        title: "Import summary",
        detected: blocks.length,
        blocks,
        savedToDb: saveToDb && !dbSkipped && !dbErr,
        inserted,
        dbSkipped,
        dbErr
      });
    }

    // JSON response for API callers
    return res.json({ success: true, parsed: blocks.length, savedToDb: saveToDb && !dbSkipped && !dbErr, inserted, dbSkipped, dbErr });

  } catch (err) {
    console.error("[admin/lms/import] error:", err && (err.stack || err));
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(500).send("Import failed");
    }
    return res.status(500).json({ error: "Import failed", detail: String(err.message || err) });
  }
});

// ------------------------------------------------------------------
// NEW: quiz listing + delete UI for admin
// ------------------------------------------------------------------

// GET /admin/lms/quizzes
// Lists quiz groups by source and tag (counts) and provides delete buttons
router.get("/lms/quizzes", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    // try to load Question model
    let Question;
    try {
      Question = (await import("../models/question.js")).default;
    } catch (e) {
      try {
        Question = (await import("../models/question/index.js")).default;
      } catch (e2) {
        Question = null;
      }
    }

    if (!Question) {
      // If no Question model, render a helpful page
      return safeRender(req, res, "admin/lms_quizzes", {
        title: "Quizzes",
        error: "Question model not found. Ensure ../models/question.js exists.",
        sources: [],
        tags: []
      });
    }

    // aggregate counts by source
    const bySource = await Question.aggregate([
      { $group: { _id: "$source", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // aggregate counts by tags (tags is an array)
    const byTag = await Question.aggregate([
      { $unwind: { path: "$tags", preserveNullAndEmptyArrays: true } },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // normalize results
    const sources = (bySource || []).map(s => ({ source: s._id || "undefined", count: s.count }));
    const tags = (byTag || []).map(t => ({ tag: t._id || "(no tag)", count: t.count }));

    return safeRender(req, res, "admin/lms_quizzes", {
      title: "Manage Quizzes",
      sources,
      tags,
      error: null
    });
  } catch (err) {
    console.error("[admin/lms/quizzes] error:", err && (err.stack || err));
    return safeRender(req, res, "admin/lms_quizzes", {
      title: "Manage Quizzes",
      sources: [],
      tags: [],
      error: String(err.message || err)
    });
  }
});

// POST /admin/lms/quizzes/delete
// Body: { type: "source"|"tag", value: "<value>" }
// deletes matching questions (after admin confirmation in UI)
router.post("/lms/quizzes/delete", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const type = req.body && req.body.type;
    const value = req.body && req.body.value;
    if (!type || !value) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(400).send("Missing type or value");
      }
      return res.status(400).json({ error: "Missing type or value" });
    }

    // load model
    let Question;
    try {
      Question = (await import("../models/question.js")).default;
    } catch (e) {
      try {
        Question = (await import("../models/question/index.js")).default;
      } catch (e2) {
        Question = null;
      }
    }

    if (!Question) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(500).send("Question model not found");
      }
      return res.status(500).json({ error: "Question model not found" });
    }

    let filter = {};
    if (type === "source") {
      filter = { source: value };
    } else if (type === "tag") {
      filter = { tags: value };
    } else {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(400).send("Invalid delete type");
      }
      return res.status(400).json({ error: "Invalid delete type" });
    }

    // optionally you might want to require an additional "confirm" param; UI already confirms via JS
    const deleteResult = await Question.deleteMany(filter);

    console.log(`[admin/lms/quizzes/delete] admin=${(req.user && req.user.email)} deleted ${deleteResult.deletedCount} docs for ${type}=${value}`);

    // redirect back to list
    return res.redirect("/admin/lms/quizzes");
  } catch (err) {
    console.error("[admin/lms/quizzes/delete] error:", err && (err.stack || err));
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(500).send("Delete failed");
    }
    return res.status(500).json({ error: "Delete failed", detail: String(err.message || err) });
  }
});

/**
 * ADMIN: backup / delete all questions
 *
 * - GET  /admin/lms/questions/export    => download JSON backup of all questions
 * - POST /admin/lms/questions/delete-all => delete all questions from DB + remove fallback file
 *
 * Protect these endpoints with ensureAuth + ensureAdmin
 */


// Backup/export all questions as JSON
router.get(
  "/lms/questions/export",
  ensureAuth,
  ensureAdmin,
  async (req, res) => {
    try {
      // try to load Question model
      let Question = null;
      try {
        Question = (await import("../models/question.js")).default;
      } catch (e) {
        try {
          Question = (await import("../models/question/index.js")).default;
        } catch (e2) {
          Question = null;
        }
      }

      if (!Question) {
        return res.status(404).send("Question model not found on server - cannot export.");
      }

      // stream export
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="questions_backup_${Date.now()}.json"`);

      // stream as newline-delimited JSON to avoid huge memory use
      const cursor = Question.find({}).cursor();
      res.write("[\n");
      let first = true;
      for await (const doc of cursor) {
        if (!first) res.write(",\n");
        res.write(JSON.stringify(doc));
        first = false;
      }
      res.write("\n]");
      res.end();
    } catch (err) {
      console.error("[admin/lms/questions/export] error:", err && (err.stack || err));
      return res.status(500).send("Export failed");
    }
  }
);

// Delete ALL questions (DB) and remove fallback file
router.post(
  "/lms/questions/delete-all",
  ensureAuth,
  ensureAdmin,
  async (req, res) => {
    try {
      // try to load Question model
      let Question = null;
      try {
        Question = (await import("../models/question.js")).default;
      } catch (e) {
        try {
          Question = (await import("../models/question/index.js")).default;
        } catch (e2) {
          Question = null;
        }
      }

      let deletedCount = 0;
      let dbSkipped = false;

      if (!Question) {
        dbSkipped = true;
        console.warn("[admin/lms/questions/delete-all] Question model not found — skipping DB delete.");
      } else {
        const resDelete = await Question.deleteMany({});
        deletedCount = resDelete && resDelete.deletedCount ? resDelete.deletedCount : 0;
        console.log(`[admin/lms/questions/delete-all] deleted ${deletedCount} questions`);
      }

      // remove fallback file if exists
      try {
        if (fs.existsSync(FALLBACK_PATH)) {
          fs.unlinkSync(FALLBACK_PATH);
          console.log(`[admin/lms/questions/delete-all] removed fallback file ${FALLBACK_PATH}`);
        }
      } catch (e) {
        console.warn("[admin/lms/questions/delete-all] failed to remove fallback file:", e && (e.stack || e));
      }

      // respond: if HTML request redirect back to manage UI with query
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        // Redirect to manage quizzes UI with a message flag
        const referer = "/admin/lms/quizzes";
        const q = `?deleted=${encodeURIComponent(deletedCount)}&skipped=${dbSkipped ? "1" : "0"}`;
        return res.redirect(referer + q);
      }

      return res.json({ success: true, deletedCount, dbSkipped });
    } catch (err) {
      console.error("[admin/lms/questions/delete-all] error:", err && (err.stack || err));
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(500).send("Delete failed");
      }
      return res.status(500).json({ error: "Delete failed", detail: String(err.message || err) });
    }
  }
);


// other admin routes below (user listing, visits, etc).
router.get("/users", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();
    return safeRender(req, res, "admin/users", { title: "Admin · Users", users });
  } catch (err) {
    console.error("[admin/users] error:", err && (err.stack || err));
    return res.status(500).send("Failed to load users");
  }
});

export default router;
