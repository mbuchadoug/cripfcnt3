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
    if (lines.length < 2) continue;

    // strip leading numbering if present
    if (/^\d+\.\s*/.test(lines[0])) {
      lines[0] = lines[0].replace(/^\d+\.\s*/, "");
    }
    const questionText = lines[0];

    // collect choice lines (a) b) c) d) ) in order they appear
    const choiceLines = lines.filter(l => /^[a-d][\)\.]/i.test(l));
    const choices = choiceLines.map(cl => {
      const m = cl.match(/^[a-d][\)\.]\s*(.*)$/i);
      return (m && m[1]) ? m[1].trim() : cl;
    });

    // find correct answer line
    const correctLine = lines.find(l => /Correct Answer:/i.test(l) || /^✅/u.test(l));
    let correctIndex = null;
    if (correctLine) {
      const m = correctLine.match(/Correct Answer:\s*([a-d])\)?/i);
      if (m) {
        const letter = m[1].toLowerCase();
        correctIndex = { a:0,b:1,c:2,d:3 }[letter];
      } else {
        // fallback: match provided text to one of the choices
        const after = correctLine.replace(/Correct Answer:\s*/i, "").replace(/^✅\s*/u, "").trim();
        if (after) {
          const found = choices.findIndex(c => c.toLowerCase().startsWith(after.toLowerCase()) || c.toLowerCase() === after.toLowerCase());
          if (found >= 0) correctIndex = found;
        }
      }
    }

    if (!questionText || choices.length === 0) continue;

    // store choices as embedded objects { text: ... } (matches typical Mongoose embedded shape)
    parsed.push({
      text: questionText,
      choices: choices.map(c => ({ text: String(c).trim() })),
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
 * If 'save' param present (save=1) will attempt to save parsed questions to DB.
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

    // Save fallback file to disk so API /mnt/data reads it even if DB not used
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
        // dynamic import of Question model (best-effort)
        let Question = null;
        try {
          Question = (await import("../models/question.js")).default;
        } catch (e1) {
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
          // Prepare docs to match common embedded-choice schema: choices: [{ text }]
          const toInsert = blocks.map(b => {
            return {
              text: b.text,
              // ensure the choices are objects (they already are from parser)
              choices: Array.isArray(b.choices) ? b.choices.map(ch => (typeof ch === "string" ? { text: ch } : { text: String(ch.text || ch) })) : [],
              correctIndex: (typeof b.correctIndex === "number" && b.correctIndex >= 0) ? b.correctIndex : 0,
              tags: ["responsibility"],
              source: "import",
              createdAt: new Date()
            };
          });

          // insertMany with ordered:false so one bad doc won't block all inserts
          const result = await Question.insertMany(toInsert, { ordered: false }).catch(e => { throw e; });
          inserted = (result && result.length) ? result.length : 0;
          console.log(`[admin/lms/import] inserted ${inserted} questions into DB`);
        }
      } catch (err) {
        console.error("[admin/lms/import] DB insert error:", err && (err.stack || err));
        dbErr = String(err.message || err);
      }
    }

    // Render preview page (HTML) with summary
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

// --- Example admin users page (kept minimal) ---
router.get("/users", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();
    return safeRender(req, res, "admin/users", { title: "Admin · Users", users });
  } catch (err) {
    console.error("[admin/users] error:", err && (err.stack || err));
    return res.status(500).send("Failed to load users");
  }
});

// You can add additional admin endpoints (visits, unique-visitors, etc.) below if needed.

export default router;
