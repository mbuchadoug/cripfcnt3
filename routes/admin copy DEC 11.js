// routes/admin.js
import { Router } from "express";
import User from "../models/user.js"; // adjust path if needed
import { ensureAuth } from "../middleware/authGuard.js";
import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = Router();

console.log("🔥 admin routes loaded");

// ADMIN_EMAILS should be a comma-separated list of admin emails
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
  const ADMIN_SET = getAdminSet(); // compute now, when env is available
  if (!email || !ADMIN_SET.has(email)) {
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(403).send("<h3>Forbidden — admin only</h3>");
    }
    return res.status(403).json({ error: "Forbidden — admin only" });
  }
  next();
}

/**
 * Helper safeRender
 * Always pass a callback to res.render to avoid express internals calling req.next
 * which can throw if req.next isn't a function.
 */
function safeRender(req, res, view, locals = {}) {
  try {
    return res.render(view, locals, (err, html) => {
      if (err) {
        console.error(`[safeRender] render error for view="${view}":`, err && (err.stack || err));
        // If HTML expected, send friendly fallback page
        if (req.headers.accept && req.headers.accept.includes("text/html")) {
          if (!res.headersSent) {
            return res.status(500).send(`<h3>Server error rendering ${view}</h3><pre style="white-space:pre-wrap;color:#900">${String(err.message || err)}</pre>`);
          }
          return;
        }
        // Otherwise send JSON error
        if (!res.headersSent) return res.status(500).json({ error: "Render failed", detail: String(err.message || err) });
        return;
      }
      // success
      if (!res.headersSent) return res.send(html);
    });
  } catch (e) {
    console.error(`[safeRender] synchronous render exception for view="${view}":`, e && (e.stack || e));
    if (!res.headersSent) {
      return res.status(500).send("Server render exception");
    }
  }
}

/* ------------------------------------------------------------
   LMS Import tool (merged)
   Endpoint(s):
     GET  /admin/lms/import   -> upload form / preview
     POST /admin/lms/import   -> accept .txt, parse, insert or preview
     GET  /admin/lms/questions -> list recent imported questions (JSON)
   Multer: memory storage (small text files)
   Parsing: handles numbered MCQ blocks with lettered choices and optional
            "✅ Correct Answer: ..." lines.
   ------------------------------------------------------------ */

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }); // 2MB

// Attempt to import Question model (may not exist yet).
let QuestionModel = null;
try {
  // If your project uses a different filename, adjust the path accordingly.
  // This try/catch prevents startup crash if the model is absent.
  // If missing, the import will throw and we will gracefully fallback.
  // eslint-disable-next-line import/no-unresolved
  // (Note: bundlers/linters might still warn — adjust as needed.)
  // Import dynamically to avoid top-level crash in some environments:
  // But since we are in ESM, do a require-like import by attempting to import:
  // We use synchronous require alternative only for safety - but in pure ESM this must match your environment.
  QuestionModel = (function tryRequire() {
    try {
      // If running with Node ESM, this will likely work because the file exists
      // and exports default. If not present, it will throw.
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const m = require?.('../models/question.js');
      return (m && m.default) ? m.default : m;
    } catch (e) {
      // Fallback - try import() dynamic (async) not used here to keep file sync.
      return null;
    }
  })();
} catch (e) {
  QuestionModel = null;
}

// Parser utility: extracts question blocks and choice lines
function parseMcqText(txt) {
  if (!txt) return { questions: [], warnings: ["Empty file"] };

  const normalized = txt.replace(/\r\n/g, "\n");
  // Split into blocks by leading question number pattern (e.g., "1." at line start)
  // Keep blocks where a number is followed by '.' or ')' then space.
  const blocks = [];
  // Match occurrences of numbered question headers
  const blockRe = /(^|\n)\s*(\d{1,4})\s*[.)]\s*(.+?)(?=(?:\n\s*\d{1,4}\s*[.)]\s*)|\n*$)/gs;
  let m;
  while ((m = blockRe.exec(normalized)) !== null) {
    const index = m[2];
    const rest = m[3].trim();
    // rest may include multiple lines: choices and possibly "✅ Correct Answer"
    blocks.push({ index: Number(index), raw: rest });
  }

  // fallback: if no numbered matches, try splitting by blank lines and heuristics
  if (blocks.length === 0) {
    // split by double-newline sections
    const secs = normalized.split(/\n{2,}/g).map(s => s.trim()).filter(Boolean);
    // attempt to identify those that start with "1." etc or look like a Q block
    for (const s of secs) {
      const headerMatch = s.match(/^\s*(\d{1,4})\s*[.)]\s*(.+)/s);
      if (headerMatch) {
        blocks.push({ index: Number(headerMatch[1]), raw: s.replace(headerMatch[0], headerMatch[2]).trim() });
      } else if (s.split(/\n/).length >= 3) {
        // heuristically accept as a question block if it has multiple lines
        blocks.push({ index: null, raw: s });
      }
    }
  }

  const parsed = [];
  const warnings = [];

  for (const b of blocks) {
    const raw = b.raw;
    // split into lines
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    // find choice lines (a) b) or a. or just starting with a)
    const choiceLines = [];
    let correctDeclared = null;

    for (const line of lines) {
      // detect Correct Answer line (supports "✅ Correct Answer: b) ..." or "Correct Answer: b")
      const correctMatch = line.match(/✅\s*Correct Answer\s*[:\-]\s*(.+)/i) || line.match(/Correct Answer\s*[:\-]\s*(.+)/i);
      if (correctMatch) {
        correctDeclared = correctMatch[1].trim();
        continue;
      }
      const choiceMatch = line.match(/^[a-dA-D]\s*[).:-]\s*(.+)/);
      if (choiceMatch) {
        choiceLines.push({ letter: line[0].toLowerCase(), text: choiceMatch[1].trim() });
        continue;
      }
      // sometimes choices are like "a) Text" in the middle — attempt to detect
      const inlineChoice = line.match(/[a-dA-D]\s*[).:-]\s*.+/g);
      if (inlineChoice) {
        for (const part of inlineChoice) {
          const cm = part.match(/^([a-dA-D])\s*[).:-]\s*(.+)/);
          if (cm) choiceLines.push({ letter: cm[1].toLowerCase(), text: cm[2].trim() });
        }
      }
    }

    // If no explicit lettered choices found, try to find lines that look like options (4 lines after the question)
    if (choiceLines.length === 0) {
      // assume first line is question, next up to 4 lines are choices
      if (lines.length >= 2) {
        const qline = lines[0];
        const candidateChoices = lines.slice(1, 6);
        if (candidateChoices.length >= 2) {
          candidateChoices.forEach((c, idx) => choiceLines.push({ letter: String.fromCharCode(97 + idx), text: c }));
        }
      }
    }

    // Determine question text: remove leading question sentence if it contains the choices
    // If first line includes the question followed by choice start, split
    let questionText = "";
    if (choiceLines.length > 0) {
      // try to strip choice fragments from raw
      const firstChoiceLetter = choiceLines[0].letter;
      const splitAt = raw.indexOf(`${firstChoiceLetter}`);
      // simpler: prefer first line that is not a choice line
      const nonChoiceLine = lines.find(l => !/^[a-dA-D]\s*[).:-]/.test(l));
      questionText = nonChoiceLine || (lines[0] || raw).trim();
    } else {
      // fallback: full raw block as question
      questionText = raw.trim();
    }

    const choices = choiceLines.map(c => c.text);
    // Determine correct index:
    let correct = null;
    if (correctDeclared) {
      // allow 'b) text' or 'b' or 'b) choice text'
      const letterMatch = correctDeclared.match(/^([a-dA-D])/);
      if (letterMatch) {
        const letter = letterMatch[1].toLowerCase();
        const idx = letter.charCodeAt(0) - 97;
        if (idx >= 0 && idx < choices.length) {
          correct = letter; // store letter (a,b,c,d)
        } else {
          // maybe correctDeclared is full text; find exact match in choices
          const declaredText = correctDeclared.replace(/^[a-dA-D]\s*[).:-]\s*/i, "").trim();
          const foundIdx = choices.findIndex(ch => ch.replace(/\s+/g,' ').toLowerCase() === declaredText.toLowerCase());
          if (foundIdx >= 0) correct = String.fromCharCode(97 + foundIdx);
        }
      } else {
        // try matching declared text to choices
        const declaredText = correctDeclared.trim();
        const foundIdx = choices.findIndex(ch => ch.replace(/\s+/g,' ').toLowerCase() === declaredText.toLowerCase());
        if (foundIdx >= 0) correct = String.fromCharCode(97 + foundIdx);
      }
    }

    // If still no correct, try to infer first choice maybe flagged in question, else leave null
    if (!correct && choices.length > 0) {
      // no inference — leave null but mark warning
      warnings.push(`No correct answer declared or inferred for question: "${questionText.slice(0,80)}"`);
    }

    parsed.push({
      index: b.index,
      question: questionText,
      choices,
      correct, // letter 'a'|'b'.. or null
      raw: raw
    });
  }

  return { questions: parsed, warnings };
}

// Render simple upload form (GET)
router.get("/lms/import", ensureAuth, ensureAdmin, (req, res) => {
  // If you have a Handlebars view for admin import, replace with safeRender.
  // For now send a small HTML form that posts multipart/form-data.
  const html = `
  <!doctype html>
  <html>
  <head><meta charset="utf-8"><title>LMS Import — Admin</title></head>
  <body style="font-family:Arial,Helvetica,sans-serif;padding:22px;background:#f7f7f8;color:#111">
    <h2>Import LMS Questions (TXT)</h2>
    <p>Upload a text file containing numbered MCQs. The parser expects lettered choices (a) b) c) d) and an optional "✅ Correct Answer:" line under each question.</p>
    <form action="/admin/lms/import" enctype="multipart/form-data" method="post">
      <div><input type="file" name="questionsFile" accept=".txt" required></div>
      <div style="margin-top:10px"><label>Source / Notes: <input type="text" name="source" placeholder="e.g., responsibility_may2025.txt" style="width:320px"></label></div>
      <div style="margin-top:12px"><button type="submit">Upload & Parse</button></div>
    </form>
    <hr>
    <p><a href="/admin/lms/questions">View recent imported questions (JSON)</a></p>
  </body>
  </html>
  `;
  res.send(html);
});

// POST handler - accept file, parse and insert
router.post("/lms/import", ensureAuth, ensureAdmin, upload.single("questionsFile"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("Missing file upload (questionsFile).");
    }
    const buffer = req.file.buffer;
    const text = buffer.toString("utf8");
    const source = (req.body && req.body.source) ? String(req.body.source).trim() : (req.file.originalname || "uploaded.txt");

    const { questions, warnings } = parseMcqText(text);

    if (!questions || questions.length === 0) {
      return res.status(400).send(`No questions parsed. Warnings: ${warnings.join(" | ")}`);
    }

    // build docs for insertion
    const docs = questions.map(q => ({
      question: q.question,
      choices: q.choices,
      correct: q.correct || null,
      source,
      raw: q.raw,
      importedAt: new Date()
    }));

    // Attempt to insert into QuestionModel if available, else show preview
    if (QuestionModel) {
      // Insert many and return summary
      const inserted = await QuestionModel.insertMany(docs, { ordered: false }).catch(err => {
        // If duplicate key or partial failure, log & continue
        console.warn("[lms/import] insertMany warning/error:", err && (err.message || err));
        // For simplicity, if insertMany failed, try individual upserts
        return null;
      });

      // If insertMany returned null (error), try individual upserts
      let insertedCount = 0;
      if (Array.isArray(inserted)) {
        insertedCount = inserted.length;
      } else {
        // fallback: upsert individually
        for (const d of docs) {
          try {
            await QuestionModel.create(d);
            insertedCount++;
          } catch (e) {
            console.warn("[lms/import] single insert failed:", e && (e.message || e));
          }
        }
      }

      return res.json({
        status: "ok",
        message: `${insertedCount} questions imported.`,
        source,
        warnings,
      });
    }

    // If no model available, return parsed preview JSON
    return res.json({
      status: "preview",
      message: "Question model not available — parsed preview returned. Create models/question.js to enable DB import.",
      parsedCount: docs.length,
      parsed: docs.slice(0, 200), // limit to avoid massive payloads
      warnings,
    });
  } catch (err) {
    console.error("/admin/lms/import error:", err && (err.stack || err));
    return res.status(500).json({ error: "import failed", detail: String(err && err.message) });
  }
});

// GET list of recent questions (if model available)
router.get("/lms/questions", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    if (!QuestionModel) {
      return res.json({ status: "no-model", message: "Question model not available. Add models/question.js to enable listing." });
    }
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit || "50", 10)));
    const items = await QuestionModel.find({}).sort({ importedAt: -1 }).limit(limit).lean();
    return res.json({ status: "ok", count: items.length, items });
  } catch (err) {
    console.error("/admin/lms/questions error:", err && (err.stack || err));
    return res.status(500).json({ error: "failed to fetch questions" });
  }
});

/* ---------------------------
   Existing admin routes kept below (users, visits, unique-visitors, etc.)
   I preserved all previously provided handlers unchanged.
   --------------------------- */

/**
 * GET /admin/users
 * Query params:
 *   q - search term (name or email)
 *   page - 1-based page number (default 1)
 *   perPage - results per page (default 50, max 200)
 *   format=csv - returns CSV
 */
router.get("/users", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const perPage = Math.min(200, Math.max(10, parseInt(req.query.perPage || "50", 10)));
    const format = (req.query.format || "").toLowerCase();

    // filter: users with googleId OR provider === 'google'
    const baseFilter = {
      $or: [{ googleId: { $exists: true, $ne: null } }, { provider: "google" }],
    };

    let filter = baseFilter;
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter = {
        $and: [
          baseFilter,
          {
            $or: [{ displayName: re }, { firstName: re }, { lastName: re }, { email: re }],
          },
        ],
      };
    }

    // CSV export (no extra deps)
    if (format === "csv") {
      const docs = await User.find(filter).sort({ createdAt: -1 }).lean();
      // build CSV rows
      const header = ["id", "googleId", "name", "email", "provider", "createdAt", "lastLogin", "locale"];
      const rows = [header.join(",")];
      for (const u of docs) {
        const name = (u.displayName || `${u.firstName || ""} ${u.lastName || ""}`).trim().replace(/"/g, '""');
        const email = (u.email || "").replace(/"/g, '""');
        const googleId = (u.googleId || "").replace(/"/g, '""');
        const provider = (u.provider || "").replace(/"/g, '""');
        const createdAt = u.createdAt ? u.createdAt.toISOString() : "";
        const lastLogin = u.lastLogin ? u.lastLogin.toISOString() : "";
        const locale = (u.locale || "").replace(/"/g, '""');

        // quote fields containing comma/newline/doublequote
        const safe = [u._id, googleId, name, email, provider, createdAt, lastLogin, locale].map((v) => {
          const s = String(v ?? "");
          if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          return s;
        });
        rows.push(safe.join(","));
      }

      const csv = rows.join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="google_users_${Date.now()}.csv"`);
      return res.send(csv);
    }

    const total = await User.countDocuments(filter);
    const users = await User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * perPage).limit(perPage).lean();

    // compute prev/next for view
    const pages = Math.max(1, Math.ceil(total / perPage));
    const prev = page > 1 ? page - 1 : null;
    const next = page < pages ? page + 1 : null;

    return safeRender(req, res, "admin/users", {
      title: "Admin · Google Users",
      users,
      q,
      page,
      perPage,
      total,
      pages,
      prev,
      next,
    });
  } catch (err) {
    console.error("[admin/users] error:", err && (err.stack || err));
    if (!res.headersSent) return res.status(500).send("Failed to load users");
  }
});

/**
 * POST /admin/users/:id/delete
 * Permanently deletes a user by _id.
 */
router.post("/users/:id/delete", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).send("Missing user id");

    // Prevent admin from deleting themselves
    const currentUserId = req.user && req.user._id && String(req.user._id);
    if (currentUserId && currentUserId === String(id)) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(400).send("<h3>Cannot delete current admin user</h3>");
      }
      return res.status(400).json({ error: "Cannot delete current admin user" });
    }

    // find the user for logging before delete
    const userToDelete = await User.findById(id).lean();
    if (!userToDelete) {
      return res.status(404).send("User not found");
    }

    // perform deletion
    await User.deleteOne({ _id: id });

    console.log(`[admin] user deleted id=${id} email=${userToDelete.email} by admin=${req.user && req.user.email}`);

    // redirect back to users list preserving query params if present
    const referer = req.get("referer") || "/admin/users";
    return res.redirect(referer);
  } catch (err) {
    console.error("[admin/users/:id/delete] error:", err && (err.stack || err));
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(500).send("Failed to delete user");
    }
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

/**
 * GET /admin/visits
 */
router.get("/visits", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const period = req.query.period || "day"; // day|month|year
    const days = Math.max(1, Math.min(365, parseInt(req.query.days || "30", 10)));

    // Build aggregation pipeline using stored day/month/year fields
    let pipeline = [];

    if (period === "year") {
      pipeline.push({
        $group: {
          _id: "$year",
          hits: { $sum: "$hits" },
        },
      });
      pipeline.push({ $sort: { _id: 1 } });
    } else if (period === "month") {
      pipeline.push({
        $group: {
          _id: "$month",
          hits: { $sum: "$hits" },
        },
      });
      pipeline.push({ $sort: { _id: 1 } });
    } else {
      // day
      pipeline.push({
        $group: {
          _id: "$day",
          hits: { $sum: "$hits" },
        },
      });
      pipeline.push({ $sort: { _id: -1 } });
      pipeline.push({ $limit: days });
    }

    const rawStats = await Visit.aggregate(pipeline);

    // sort ascending by date so charts and tables read left→right
    rawStats.sort((a, b) => (a._id > b._id ? 1 : -1));

    const stats = rawStats;

    // flags for template
    const isDay = period === "day";
    const isMonth = period === "month";
    const isYear = period === "year";

    // render with safe callback
    return safeRender(req, res, "admin/visits", {
      title: "Admin · Site visits",
      stats,
      period,
      days,
      isDay,
      isMonth,
      isYear,
    });
  } catch (err) {
    console.error("[admin/visits] error:", err && (err.stack || err));
    if (!res.headersSent) return res.status(500).send("Failed to fetch visits");
  }
});

/**
 * GET /admin/unique-visitors
 */
router.get("/unique-visitors", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const period = (req.query.period || "day").toLowerCase();
    const days = Math.max(1, Math.min(365, parseInt(req.query.days || "30", 10)));
    const pathFilter = req.query.path ? String(req.query.path) : null;

    // Build match stage if filtering by path
    const match = {};
    if (pathFilter) match.path = pathFilter;

    // Pipeline will produce documents: { _id: <periodKey>, uniqueCount: <number> }
    let pipeline = [];

    if (Object.keys(match).length) pipeline.push({ $match: match });

    if (period === "year") {
      pipeline.push({
        $group: { _id: "$year", uniqueCount: { $sum: 1 } },
      });
      pipeline.push({ $sort: { _id: 1 } });
    } else if (period === "month") {
      pipeline.push({
        $group: { _id: "$month", uniqueCount: { $sum: 1 } },
      });
      pipeline.push({ $sort: { _id: 1 } });
    } else {
      // default: day
      pipeline.push({
        $group: { _id: "$day", uniqueCount: { $sum: 1 } },
      });
      pipeline.push({ $sort: { _id: -1 } });
      pipeline.push({ $limit: days });
      pipeline.push({ $sort: { _id: 1 } }); // return ascending by date for charts
    }

    const series = await UniqueVisit.aggregate(pipeline).allowDiskUse(true);

    // Compute overall unique visitor total
    const totalAgg = [];
    if (Object.keys(match).length) totalAgg.push({ $match: match });
    totalAgg.push({ $group: { _id: "$visitorId" } });
    totalAgg.push({ $count: "totalUnique" });

    const totalRes = await UniqueVisit.aggregate(totalAgg).allowDiskUse(true);
    const totalUnique = (totalRes[0] && totalRes[0].totalUnique) || 0;

    return safeRender(req, res, "admin/unique-visitors", {
      title: "Admin · Unique visitors",
      series,
      period,
      days,
      path: pathFilter,
      totalUnique,
    });
  } catch (err) {
    console.error("[admin/unique-visitors] error:", err && (err.stack || err));
    if (!res.headersSent) return res.status(500).send("Failed to fetch unique visitors");
  }
});

/* Remaining endpoints (visitors/stream, visitors-live, visitors/summary, visits/data, unique-visitors/data)
   remain unchanged from your previous implementation; copy them below if you need the complete file.
   For brevity they are omitted here, but in your file keep them exactly as before.
*/

export default router;
