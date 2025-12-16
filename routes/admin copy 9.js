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
 * Parser for the quiz text format with a merge pass to avoid separated question headings.
 *
 * Blocks are split on two-or-more newlines. If a block looks like a question-only
 * heading (e.g. "1. question...") and the next block starts with choice markers
 * (a) b) ...), they are merged before parsing.
 */
function parseQuestionBlocks(raw) {
  if (!raw || typeof raw !== "string") return [];
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // initial raw blocks split (two or more newlines)
  let rawBlocks = normalized.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);

  // Merge pass: when a block is likely just a numbered heading and the next block starts
  // with choices, merge them to avoid the importer splitting question+choices.
  const merged = [];
  for (let i = 0; i < rawBlocks.length; i++) {
    const cur = rawBlocks[i];
    const nxt = rawBlocks[i + 1];

    const looksLikeHeadingOnly = (() => {
      if (!cur) return false;
      const lines = cur.split("\n").map(l => l.trim()).filter(Boolean);
      if (!lines.length) return false;
      // if block contains no choice markers and the first line starts with digits + '.' treat as heading-only
      const hasChoice = lines.some(l => /^[a-d][\.\)]\s+/i.test(l) || /^\([a-d]\)\s+/i.test(l));
      if (hasChoice) return false;
      if (/^\d+\.\s*/.test(lines[0]) && lines.length <= 2) return true;
      // fallback: single short line (as heading)
      if (lines.length === 1 && lines[0].length < 240 && !/^[a-d][\.\)]\s+/i.test(lines[0])) return true;
      return false;
    })();

    const nextStartsWithChoice = (() => {
      if (!nxt) return false;
      const first = nxt.split("\n").map(l => l.trim()).find(Boolean) || "";
      return /^[\(\[]?[a-d][\)\.\]]?\s+/i.test(first) || /^[a-d]\s+/.test(first);
    })();

    if (looksLikeHeadingOnly && nextStartsWithChoice) {
      merged.push((cur + "\n\n" + nxt).trim());
      i++; // skip next
    } else {
      merged.push(cur);
    }
  }

  const parsed = [];

  // parse each merged block
  for (const block of merged) {
    const lines = block.split("\n").map(l => l.replace(/\t/g, ' ').trim()).filter(Boolean);
    if (!lines.length) continue;

    const isChoiceLine = (s) => /^[a-d][\.\)]\s+/i.test(s) || /^\([a-d]\)\s+/i.test(s);
    const isCorrectLine = (s) => /Correct Answer:/i.test(s) || /✅\s*Correct Answer:/i.test(s);

    let firstChoiceIdx = lines.findIndex(isChoiceLine);
    if (firstChoiceIdx === -1) firstChoiceIdx = lines.findIndex(l => /^[a-d]\s+/.test(l));

    let questionLines = [];
    let choiceLines = [];
    let footerLines = [];

    if (firstChoiceIdx > 0) {
      questionLines = lines.slice(0, firstChoiceIdx);
      let i = firstChoiceIdx;
      for (; i < lines.length; i++) {
        const ln = lines[i];
        if (isCorrectLine(ln)) {
          footerLines.push(ln);
          i++;
          break;
        }
        if (isChoiceLine(ln) || /^[a-d]\s+/.test(ln)) {
          choiceLines.push(ln);
        } else {
          if (choiceLines.length) {
            choiceLines[choiceLines.length - 1] += " " + ln;
          } else {
            questionLines.push(ln);
          }
        }
      }
      for (let j = i; j < lines.length; j++) footerLines.push(lines[j]);
    } else {
      // heuristic: first line question, rest choices/footers
      questionLines = [lines[0]];
      for (let i = 1; i < lines.length; i++) {
        const ln = lines[i];
        if (isChoiceLine(ln) || /^[a-d]\s+/.test(ln) || /^[A-D]\)\s+/.test(ln)) {
          choiceLines.push(ln);
        } else if (isCorrectLine(ln)) {
          footerLines.push(ln);
        } else {
          if (!choiceLines.length) questionLines.push(ln);
          else choiceLines[choiceLines.length - 1] += " " + ln;
        }
      }
    }

    let questionText = questionLines.join(" ").trim();
    questionText = questionText.replace(/^\d+\.\s*/, "").trim();

    const choices = choiceLines.map(cl => ({ text: cl.replace(/^[\(\[]?[a-d][\)\.\]]?\s*/i, "").trim() }));

    // determine correct index from footer if any
    let correctIndex = null;
    const footer = footerLines.join(" ").trim();
    if (footer) {
      const m = footer.match(/Correct Answer:\s*[:\-]?\s*([a-d])\b/i);
      if (m) {
        correctIndex = { a: 0, b: 1, c: 2, d: 3 }[m[1].toLowerCase()];
      } else {
        const m2 = footer.match(/([a-d])\)/i);
        if (m2) correctIndex = { a: 0, b: 1, c: 2, d: 3 }[m2[1].toLowerCase()];
        else {
          const stripped = footer.replace(/Correct Answer:/i, "").replace(/✅/g, "").trim().toLowerCase();
          const found = choices.findIndex(c => {
            const lc = (c.text || "").toLowerCase().replace(/^[\)\.:\s]*/, "");
            return lc.startsWith(stripped) || lc === stripped || stripped.startsWith(lc);
          });
          if (found >= 0) correctIndex = found;
        }
      }
    }

    if (!questionText) continue;
    if (!choices || !choices.length) continue;

    parsed.push({
      text: questionText,
      choices,
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
 * If 'save' param present (save=1), attempt to save parsed questions to DB (Questions collection).
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
          // map parsed blocks into the DB schema shape (choices as embedded docs)
          const toInsert = blocks.map(b => ({
            text: b.text,
            choices: (b.choices || []).map(c => ({ text: c.text })),
            correctIndex: typeof b.correctIndex === "number" ? b.correctIndex : null,
            tags: ["responsibility"],
            source: req.body.source || "import",
            raw: b.rawBlock,
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

/**
 * GET /admin/lms/quizzes
 * Manage quizzes view - shows detected sources and tags from DB.
 */
router.get("/lms/quizzes", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    let Question;
    try {
      Question = (await import("../models/question.js")).default;
    } catch (e) {
      Question = null;
    }

    let sources = [];
    let tags = [];

    if (Question) {
      sources = await Question.distinct("source").catch(() => []);
      tags = await Question.distinct("tags").catch(() => []);
      tags = (Array.isArray(tags) ? tags.flat() : tags).filter(Boolean);
    }

    return safeRender(req, res, "admin/lms_quizzes", { title: "Manage Quizzes", sources: sources || [], tags: tags || [] });
  } catch (err) {
    console.error("[admin/lms/quizzes] error:", err && (err.stack || err));
    return res.status(500).send("Failed to load quizzes");
  }
});

/**
 * POST /admin/lms/quizzes/delete
 * Convenience endpoint: deletes by source OR tag OR all (if no filter provided).
 * Accepts form or JSON.
 */
router.post("/lms/quizzes/delete", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    let Question;
    try {
      Question = (await import("../models/question.js")).default;
    } catch (e) {
      Question = null;
    }

    if (!Question) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(500).send("Question model not found on server; cannot delete from DB.");
      }
      return res.status(500).json({ error: "Question model not found" });
    }

    const filterType = req.body && req.body.filter;
    const value = req.body && req.body.value;

    let filter = {};
    if (filterType === "source" && value) {
      filter.source = value;
    } else if (filterType === "tag" && value) {
      filter.tags = value;
    } else {
      filter = {};
    }

    const deleteRes = await Question.deleteMany(filter);
    console.log(`[admin/lms/quizzes/delete] deleted ${deleteRes.deletedCount} questions (filter: ${JSON.stringify(filter)})`);

    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.redirect("/admin/lms/quizzes?deleted=" + encodeURIComponent(deleteRes.deletedCount));
    }
    return res.json({ deleted: deleteRes.deletedCount, filter });
  } catch (err) {
    console.error("[admin/lms/quizzes/delete] error:", err && (err.stack || err));
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(500).send("Failed to delete questions");
    }
    return res.status(500).json({ error: "delete failed", detail: String(err.message || err) });
  }
});

// other admin routes (users)
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
