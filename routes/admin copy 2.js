// routes/admin.js
import { Router } from "express";
import User from "../models/user.js"; // adjust path if needed
import { ensureAuth } from "../middleware/authGuard.js";
import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";

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

/**
 * GET /admin/visitors/stream
 * SSE endpoint — pushes live aggregate stats every N seconds
 */
router.get("/visitors/stream", ensureAuth, ensureAdmin, async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // heartbeat so proxies don't close
  const keepAlive = setInterval(() => {
    try { res.write(":\n\n"); } catch (e) {}
  }, 15000);

  let intervalId = null;

  async function publish() {
    try {
      const now = new Date();
      const today = now.toISOString().slice(0, 10); // YYYY-MM-DD

      // 1) total hits today (sum Visit.hits for today)
      const aggHits = await Visit.aggregate([
        { $match: { day: today } },
        { $group: { _id: null, totalHits: { $sum: "$hits" } } },
      ]);
      const totalHits = (aggHits[0] && aggHits[0].totalHits) || 0;

      // 2) unique visitors today
      const uniqueToday = await UniqueVisit.countDocuments({ day: today });

      // 3) hits by path (top 10) for today
      const topPaths = await Visit.aggregate([
        { $match: { day: today } },
        { $group: { _id: "$path", hits: { $sum: "$hits" } } },
        { $sort: { hits: -1 } },
        { $limit: 10 },
      ]);

      const payload = { totalHits, uniqueToday, topPaths, timestamp: new Date().toISOString() };

      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      const errMsg = String(err?.message || err);
      res.write(`data: ${JSON.stringify({ error: errMsg, timestamp: new Date().toISOString() })}\n\n`);
    }
  }

  // publish immediately, then every 5s
  publish().catch(() => {});
  intervalId = setInterval(() => publish().catch(() => {}), 5000);

  // cleanup on client disconnect
  req.on("close", () => {
    clearInterval(intervalId);
    clearInterval(keepAlive);
  });
});

router.get("/visitors-live", ensureAuth, ensureAdmin, (req, res) => {
  return safeRender(req, res, "admin/visitors_live", { title: "Admin · Live Visitors" });
});


// GET /admin/visitors/summary  (returns JSON aggregates for today)
router.get("/visitors/summary", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const aggHits = await Visit.aggregate([
      { $match: { day: today } },
      { $group: { _id: null, totalHits: { $sum: "$hits" } } },
    ]);

    const totalHits = (aggHits[0] && aggHits[0].totalHits) || 0;
    const uniqueToday = await UniqueVisit.countDocuments({ day: today });

    const topPaths = await Visit.aggregate([
      { $match: { day: today } },
      { $group: { _id: "$path", hits: { $sum: "$hits" } } },
      { $sort: { hits: -1 } },
      { $limit: 10 },
    ]);

    return res.json({ totalHits, uniqueToday, topPaths, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("/admin/visitors/summary error:", err && (err.stack || err));
    return res.status(500).json({ error: "summary failed" });
  }
});


/**
 * GET /admin/visits/data
 * Query params:
 *  - period = day|week|month|year  (default day)
 *  - days = N                      (lookback days when period=day; default 30, max 365)
 *  - start=YYYY-MM-DD              (optional start date)
 *  - end=YYYY-MM-DD                (optional end date)
 *
 * Returns JSON: { period, start, end, series: [{ key: "2025-11-19" | "2025-W47" | "2025-11" | "2025", hits }] }
 */
router.get("/visits/data", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const period = (req.query.period || "day").toLowerCase();
    const days = Math.max(1, Math.min(365, parseInt(req.query.days || "30", 10)));
    const start = req.query.start ? String(req.query.start) : null;
    const end = req.query.end ? String(req.query.end) : null;

    const match = {};
    // If start/end provided, use them; else if period=day use lookback from today
    if (start || end) {
      if (start) match.day = { ...(match.day || {}), $gte: start };
      if (end) match.day = { ...(match.day || {}), $lte: end };
    } else if (period === "day") {
      const now = new Date();
      const from = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
      const fromStr = from.toISOString().slice(0, 10);
      match.day = { $gte: fromStr };
    }

    // Build aggregation pipeline that groups into requested bucket
    let groupStage;
    let projectStage = null;
    const pipeline = [];

    if (Object.keys(match).length) pipeline.push({ $match: match });

    if (period === "year") {
      groupStage = { _id: "$year", hits: { $sum: "$hits" } };
      pipeline.push({ $group: groupStage }, { $sort: { _id: 1 } });
    } else if (period === "month") {
      groupStage = { _id: "$month", hits: { $sum: "$hits" } };
      pipeline.push({ $group: groupStage }, { $sort: { _id: 1 } });
    } else if (period === "week") {
      // convert day string to date, then use ISO week + year
      // produce keys like "2025-W47" (ISO week)
      pipeline.push({
        $addFields: {
          _dayDate: { $dateFromString: { dateString: "$day", timezone: "UTC" } },
        },
      });
      pipeline.push({
        $group: {
          _id: {
            year: { $isoWeekYear: "$_dayDate" },
            week: { $isoWeek: "$_dayDate" },
          },
          hits: { $sum: "$hits" },
        },
      });
      // project a string key for client convenience
      pipeline.push({
        $project: {
          _id: { $concat: [{ $toString: "$_id.year" }, "-W", { $toString: "$_id.week" }] },
          hits: 1,
        },
      });
      pipeline.push({ $sort: { _id: 1 } });
    } else {
      // default day grouping (assumes day is stored as YYYY-MM-DD)
      groupStage = { _id: "$day", hits: { $sum: "$hits" } };
      pipeline.push({ $group: groupStage }, { $sort: { _id: 1 } });
    }

    const raw = await Visit.aggregate(pipeline).allowDiskUse(true);
    return res.json({ period, start: start || null, end: end || null, series: raw });
  } catch (err) {
    console.error("/admin/visits/data error:", err && (err.stack || err));
    return res.status(500).json({ error: "visits data failed" });
  }
});

/**
 * GET /admin/unique-visitors/data
 * Same params as /visits/data but returns unique counts per bucket
 * Response: { period, series: [{ key, count }] }
 */
router.get("/unique-visitors/data", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const period = (req.query.period || "day").toLowerCase();
    const days = Math.max(1, Math.min(365, parseInt(req.query.days || "30", 10)));
    const start = req.query.start ? String(req.query.start) : null;
    const end = req.query.end ? String(req.query.end) : null;

    const match = {};
    if (start || end) {
      if (start) match.day = { ...(match.day || {}), $gte: start };
      if (end) match.day = { ...(match.day || {}), $lte: end };
    } else if (period === "day") {
      const now = new Date();
      const from = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
      match.day = { $gte: from.toISOString().slice(0, 10) };
    }

    const pipeline = [];
    if (Object.keys(match).length) pipeline.push({ $match: match });

    if (period === "year") {
      pipeline.push({ $group: { _id: "$year", count: { $sum: 1 } } }, { $sort: { _id: 1 } });
    } else if (period === "month") {
      pipeline.push({ $group: { _id: "$month", count: { $sum: 1 } } }, { $sort: { _id: 1 } });
    } else if (period === "week") {
      pipeline.push({
        $addFields: { _dayDate: { $dateFromString: { dateString: "$day", timezone: "UTC" } } },
      });
      pipeline.push({
        $group: {
          _id: { year: { $isoWeekYear: "$_dayDate" }, week: { $isoWeek: "$_dayDate" }, visitorId: "$visitorId" },
        },
      });
      // now we have one doc per visitor per week; group by week and count distinct visitors
      pipeline.push({
        $group: { _id: { year: "$_id.year", week: "$_id.week" }, count: { $sum: 1 } },
      });
      pipeline.push({
        $project: { _id: { $concat: [{ $toString: "$_id.year" }, "-W", { $toString: "$_id.week" }] }, count: 1 },
      });
      pipeline.push({ $sort: { _id: 1 } });
    } else {
      // day default
      pipeline.push({ $group: { _id: "$day", count: { $sum: 1 } } }, { $sort: { _id: 1 } });
    }

    const raw = await UniqueVisit.aggregate(pipeline).allowDiskUse(true);
    return res.json({ period, start: start || null, end: end || null, series: raw });
  } catch (err) {
    console.error("/admin/unique-visitors/data error:", err && (err.stack || err));
    return res.status(500).json({ error: "unique visitors data failed" });
  }
});


export default router;
