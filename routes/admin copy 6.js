// routes/admin.js
import { Router } from "express";
import User from "../models/user.js";
import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";
import Question from "../models/question.js"; // make sure this model exists (see example in the note)
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

console.log("🔥 admin routes loaded");

/**
 * getAdminSet / ensureAdmin
 */
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

/**
 * safeRender helper — ensures res.render uses callback to avoid internal next call problems
 */
function safeRender(req, res, view, locals = {}) {
  try {
    return res.render(view, locals, (err, html) => {
      if (err) {
        console.error(`[safeRender] render error for view="${view}":`, err && (err.stack || err));
        if (req.headers.accept && req.headers.accept.includes("text/html")) {
          if (!res.headersSent) {
            return res.status(500).send(`<h3>Server error rendering ${view}</h3><pre style="white-space:pre-wrap;color:#900">${String(err.message || err)}</pre>`);
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

/* -----------------------------------------
   Admin: Users list + delete (kept)
   ----------------------------------------- */

/**
 * GET /admin/users
 * (search & CSV export)
 */
router.get("/users", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const perPage = Math.min(200, Math.max(10, parseInt(req.query.perPage || "50", 10)));
    const format = (req.query.format || "").toLowerCase();

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

    if (format === "csv") {
      const docs = await User.find(filter).sort({ createdAt: -1 }).lean();
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
 */
router.post("/users/:id/delete", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).send("Missing user id");
    const currentUserId = req.user && req.user._id && String(req.user._id);
    if (currentUserId && currentUserId === String(id)) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(400).send("<h3>Cannot delete current admin user</h3>");
      }
      return res.status(400).json({ error: "Cannot delete current admin user" });
    }
    const userToDelete = await User.findById(id).lean();
    if (!userToDelete) {
      return res.status(404).send("User not found");
    }
    await User.deleteOne({ _id: id });
    console.log(`[admin] user deleted id=${id} email=${userToDelete.email} by admin=${req.user && req.user.email}`);
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
 * Visits / unique visitors / visitors stream
 * (kept from previous file)
 */
router.get("/visits", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const period = req.query.period || "day";
    const days = Math.max(1, Math.min(365, parseInt(req.query.days || "30", 10)));
    let pipeline = [];
    if (period === "year") {
      pipeline.push({ $group: { _id: "$year", hits: { $sum: "$hits" } } }, { $sort: { _id: 1 } });
    } else if (period === "month") {
      pipeline.push({ $group: { _id: "$month", hits: { $sum: "$hits" } } }, { $sort: { _id: 1 } });
    } else {
      pipeline.push({ $group: { _id: "$day", hits: { $sum: "$hits" } } }, { $sort: { _id: -1 } }, { $limit: days });
    }
    const rawStats = await Visit.aggregate(pipeline);
    rawStats.sort((a, b) => (a._id > b._id ? 1 : -1));
    const stats = rawStats;
    const isDay = period === "day";
    const isMonth = period === "month";
    const isYear = period === "year";
    return safeRender(req, res, "admin/visits", { title: "Admin · Site visits", stats, period, days, isDay, isMonth, isYear });
  } catch (err) {
    console.error("[admin/visits] error:", err && (err.stack || err));
    if (!res.headersSent) return res.status(500).send("Failed to fetch visits");
  }
});

router.get("/unique-visitors", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const period = (req.query.period || "day").toLowerCase();
    const days = Math.max(1, Math.min(365, parseInt(req.query.days || "30", 10)));
    const pathFilter = req.query.path ? String(req.query.path) : null;
    const match = {};
    if (pathFilter) match.path = pathFilter;
    let pipeline = [];
    if (Object.keys(match).length) pipeline.push({ $match: match });
    if (period === "year") {
      pipeline.push({ $group: { _id: "$year", uniqueCount: { $sum: 1 } } }, { $sort: { _id: 1 } });
    } else if (period === "month") {
      pipeline.push({ $group: { _id: "$month", uniqueCount: { $sum: 1 } } }, { $sort: { _id: 1 } });
    } else {
      pipeline.push({ $group: { _id: "$day", uniqueCount: { $sum: 1 } } }, { $sort: { _id: -1 } }, { $limit: days }, { $sort: { _id: 1 } });
    }
    const series = await UniqueVisit.aggregate(pipeline).allowDiskUse(true);
    const totalAgg = [];
    if (Object.keys(match).length) totalAgg.push({ $match: match });
    totalAgg.push({ $group: { _id: "$visitorId" } });
    totalAgg.push({ $count: "totalUnique" });
    const totalRes = await UniqueVisit.aggregate(totalAgg).allowDiskUse(true);
    const totalUnique = (totalRes[0] && totalRes[0].totalUnique) || 0;
    return safeRender(req, res, "admin/unique-visitors", { title: "Admin · Unique visitors", series, period, days, path: pathFilter, totalUnique });
  } catch (err) {
    console.error("[admin/unique-visitors] error:", err && (err.stack || err));
    if (!res.headersSent) return res.status(500).send("Failed to fetch unique visitors");
  }
});

/**
 * SSE for visitors (kept)
 */
router.get("/visitors/stream", ensureAuth, ensureAdmin, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const keepAlive = setInterval(() => {
    try { res.write(":\n\n"); } catch (e) {}
  }, 15000);
  let intervalId = null;
  async function publish() {
    try {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const aggHits = await Visit.aggregate([{ $match: { day: today } }, { $group: { _id: null, totalHits: { $sum: "$hits" } } }]);
      const totalHits = (aggHits[0] && aggHits[0].totalHits) || 0;
      const uniqueToday = await UniqueVisit.countDocuments({ day: today });
      const topPaths = await Visit.aggregate([{ $match: { day: today } }, { $group: { _id: "$path", hits: { $sum: "$hits" } } }, { $sort: { hits: -1 } }, { $limit: 10 }]);
      const payload = { totalHits, uniqueToday, topPaths, timestamp: new Date().toISOString() };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      const errMsg = String(err?.message || err);
      res.write(`data: ${JSON.stringify({ error: errMsg, timestamp: new Date().toISOString() })}\n\n`);
    }
  }
  publish().catch(() => {});
  intervalId = setInterval(() => publish().catch(() => {}), 5000);
  req.on("close", () => {
    clearInterval(intervalId);
    clearInterval(keepAlive);
  });
});

router.get("/visitors-live", ensureAuth, ensureAdmin, (req, res) => {
  return safeRender(req, res, "admin/visitors_live", { title: "Admin · Live Visitors" });
});

/* -----------------------------------------
   NEW: LMS Importer (preview + save to DB)
   ----------------------------------------- */

/**
 * Helper: parseQuizText
 * Accepts plain text with question blocks separated by blank lines.
 * Expected block sample:
 *
 * 1. Taking responsibility in a team means:
 *
 * a) Completing only your assigned tasks...
 * b) Stepping in where needed...
 * c) Waiting for instructions...
 * d) Avoiding tasks outside...
 *
 * ✅ Correct Answer: b) Stepping in where needed...
 *
 * This function is conservative and tries to extract:
 * - question text
 * - choices (a,b,c,d)
 * - correctIndex (0-based)
 */
function parseQuizText(text) {
  if (!text || !String(text).trim()) return [];
  const lines = String(text).replace(/\r/g, "").split("\n");
  // split into blocks on blank lines
  const blocks = [];
  let cur = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (cur.length) {
        blocks.push(cur.slice());
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) blocks.push(cur);

  const parsed = [];
  for (const block of blocks) {
    // join block to single string for ease
    const blockText = block.join("\n").trim();

    // attempt to find the question line(s) — first non-choice lines
    // find the index of first choice (a) line
    let choiceStart = -1;
    for (let i = 0; i < block.length; i++) {
      if (/^\s*[a-dA-D]\s*\)|^\s*[a-dA-D]\s*\./.test(block[i])) {
        choiceStart = i;
        break;
      }
    }

    if (choiceStart === -1) {
      // no choices detected — skip
      continue;
    }

    // question lines are before choiceStart
    const questionLines = block.slice(0, choiceStart).join(" ").replace(/^\d+\.\s*/, "").trim();
    const questionText = questionLines || "";

    // parse choices between choiceStart and maybe correct answer line
    const choices = [];
    for (let i = choiceStart; i < block.length; i++) {
      const line = block[i].trim();
      // stop if we hit "Correct Answer" line or similar
      if (/correct answer/i.test(line) || /✅|✔|Correct:/i.test(line)) break;
      const m = line.match(/^\s*([a-dA-D])\s*[)\.]?\s*(.+)$/);
      if (m) {
        choices.push({ label: m[1].toLowerCase(), text: m[2].trim() });
      } else {
        // if not match, maybe continuation of previous choice — append
        if (choices.length) {
          choices[choices.length - 1].text += " " + line;
        }
      }
    }

    // find correct answer index
    let correctIndex = null;
    for (const line of block) {
      const m = line.match(/([a-dA-D])\s*\)/);
      // prefer lines like "Correct Answer: b) text" or "✅ Correct Answer: b) ...", or "Correct Answer: b"
      if (/correct answer/i.test(line) || /✅|✔/.test(line)) {
        const mm = line.match(/([a-dA-D])\s*[\)\.]?/);
        if (mm) {
          const lab = mm[1].toLowerCase();
          const idx = choices.findIndex((c) => c.label === lab);
          if (idx !== -1) correctIndex = idx;
        }
      }
    }

    // fallback: if not found, try to search for "(b)" in any line with "Correct"
    if (correctIndex === null) {
      // look for any "Correct Answer" containing a letter
      const caLine = block.find((l) => /correct answer/i.test(l));
      if (caLine) {
        const mm = caLine.match(/([a-dA-D])/);
        if (mm) {
          const lab = mm[1].toLowerCase();
          const idx = choices.findIndex((c) => c.label === lab);
          if (idx !== -1) correctIndex = idx;
        }
      }
    }

    // last fallback: if only one choice is marked with leading "✅" or similar
    if (correctIndex === null) {
      for (let i = 0; i < choices.length; i++) {
        if (/^\s*✅|^\s*✔/.test(choices[i].text)) {
          correctIndex = i;
          // strip the mark
          choices[i].text = choices[i].text.replace(/^\s*✅\s*/, "").replace(/^\s*✔\s*/, "");
          break;
        }
      }
    }

    // if still null and choices exist, default to 0 (but mark as unsure)
    if (correctIndex === null && choices.length) correctIndex = 0;

    if (!questionText || choices.length < 2) {
      // skip invalid blocks
      continue;
    }

    parsed.push({
      raw: blockText,
      text: questionText,
      choices: choices.map((c) => ({ label: c.label, text: c.text })),
      correctIndex,
    });
  }

  return parsed;
}

/**
 * GET /admin/lms/import
 * Show importer UI (preview)
 */
router.get("/lms/import", ensureAuth, ensureAdmin, (req, res) => {
  // Render the same import view you were using (views/admin/lms_import.hbs).
  // If you don't have that view, this expects a template that posts the pasted text to POST /admin/lms/import
  return safeRender(req, res, "admin/lms_import", { title: "Import LMS Questions (paste)" });
});

/**
 * POST /admin/lms/import
 * Body parameters:
 *  - text (string) : pasted quiz text
 *  - save = "1" to persist parsed questions into DB
 */
router.post("/lms/import", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const text = req.body.text || req.body.paste || "";
    if (!text || !String(text).trim()) {
      return res.status(400).send("No text provided");
    }

    const parsed = parseQuizText(text);
    if (!parsed.length) {
      // Render a simple failure page so admin can reattempt
      return safeRender(req, res, "admin/lms_import_failed", { title: "Import failed", message: "No valid question blocks detected. Check formatting." });
    }

    // If the admin clicked the Save/Import action, persist to DB
    const wantsSave = String(req.body.save || "").trim() === "1" || req.query.save === "1";
    if (wantsSave) {
      // Build docs for insert
      const docs = parsed.map((q) => {
        const doc = {
          text: q.text,
          choices: q.choices.map((c) => ({ label: c.label, text: c.text })),
          correctIndex: (typeof q.correctIndex === "number" ? q.correctIndex : 0),
          tags: [],
          difficulty: null,
          source: "import",
          createdAt: new Date(),
        };
        return doc;
      });

      // Insert into DB
      const insertRes = await Question.insertMany(docs, { ordered: false });
      console.log(`[admin/lms/import] inserted ${insertRes.length} questions into DB by ${req.user && req.user.email}`);
      return safeRender(req, res, "admin/lms_import_saved", {
        title: "Import saved",
        count: insertRes.length,
        docs: insertRes,
      });
    }

    // Otherwise, show preview page with parsed blocks and an option to save
    return safeRender(req, res, "admin/lms_import_preview", {
      title: "Import summary",
      blocksDetected: parsed.length,
      preview: parsed.slice(0, 50), // show first 50
      originalText: text,
    });
  } catch (err) {
    console.error("[admin/lms/import] error:", err && (err.stack || err));
    // respond with simple error page
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      if (!res.headersSent) return res.status(500).send("Import failed");
      return;
    }
    return res.status(500).json({ error: "Import failed", detail: String(err && err.message) });
  }
});

/* -----------------------------------------
   Admin: Manage Questions listing (simple)
   ----------------------------------------- */

/**
 * GET /admin/lms/questions
 * List questions with pagination and quick delete
 */
router.get("/lms/questions", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const perPage = Math.min(200, Math.max(10, parseInt(req.query.perPage || "50", 10)));
    const total = await Question.countDocuments({});
    const docs = await Question.find({}).sort({ createdAt: -1 }).skip((page - 1) * perPage).limit(perPage).lean();
    return safeRender(req, res, "admin/lms_questions", {
      title: "Manage LMS Questions",
      questions: docs,
      page,
      perPage,
      total,
      pages: Math.max(1, Math.ceil(total / perPage)),
    });
  } catch (err) {
    console.error("[admin/lms/questions] error:", err && (err.stack || err));
    return res.status(500).send("Failed to load questions");
  }
});

/**
 * POST /admin/lms/questions/:id/delete
 */
router.post("/lms/questions/:id/delete", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).send("Missing id");
    await Question.deleteOne({ _id: id });
    return res.redirect("/admin/lms/questions");
  } catch (err) {
    console.error("[admin/lms/questions/:id/delete] error:", err && (err.stack || err));
    return res.status(500).send("Delete failed");
  }
});

export default router;
