// routes/track.js
import express from "express";
import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";

const router = express.Router();

// Accept tiny JSON payloads; use keepalive/sendBeacon on client
router.post("/track", express.json({ limit: "8kb" }), async (req, res) => {
  try {
    const { visitorId, path } = req.body || {};
    const now = new Date();
    const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const month = now.toISOString().slice(0, 7);
    const year = String(now.getFullYear());
    const safePath = String(path || "/").split("?")[0];

    // Upsert daily per-path Visit document
    const upsertFilter = { day, path: safePath };
    const upsertUpdate = {
      $inc: { hits: 1 },
      $setOnInsert: { firstSeenAt: new Date() },
      $set: { lastSeenAt: new Date(), month, year },
    };

    // Do DB writes and wait (keeps counts accurate)
    await Visit.updateOne(upsertFilter, upsertUpdate, { upsert: true });

    // Record unique visitor for day/path (if visitorId provided)
    if (visitorId) {
      const ufilter = { day, visitorId: String(visitorId), path: safePath };
      const uupdate = { $setOnInsert: { firstSeenAt: new Date(), month, year } };
      try {
        await UniqueVisit.updateOne(ufilter, uupdate, { upsert: true });
      } catch (e) {
        // ignore duplicate key (unique index) errors, warn others
        if (!(e && e.code === 11000)) console.warn("uniqueVisit update error:", e);
      }
    }

    // 204 no-content (tiny response)
    return res.status(204).end();
  } catch (err) {
    console.error("/api/track error:", err && (err.stack || err));
    return res.status(500).json({ error: "track failed" });
  }
});

export default router;
