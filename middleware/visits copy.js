// middleware/visits.js
import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";

const BOT_RE = /bot|crawler|spider|curl|wget|facebookexternalhit|googlebot|bingbot|slurp/i;
const STATIC_PREFIXES = ["/static/", "/css/", "/js/", "/images/", "/favicon.ico", "/docs/", "/assets/"];

export function visitTracker(req, res, next) {
  try {
    const ua = (req.headers["user-agent"] || "").toLowerCase();
    const url = req.originalUrl || req.url || "/";
    if (STATIC_PREFIXES.some(p => url.startsWith(p))) return next();
    if (BOT_RE.test(ua)) return next();

    // day/month/year
    const now = new Date();
    const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const month = now.toISOString().slice(0, 7); // YYYY-MM
    const year = now.getFullYear().toString();
    const path = (url.split("?")[0] || "/");

    const visitorId = req.visitorId || null;

    // do DB ops asynchronously so we don't block request
    setImmediate(async () => {
      try {
        // 1) increment total hits (per-day per-path doc)
        await Visit.updateOne(
          { day, path },
          {
            $inc: { hits: 1 },
            $setOnInsert: { firstSeenAt: new Date() },
            $set: { lastSeenAt: new Date(), month, year }
          },
          { upsert: true }
        );

        // 2) record unique visit only if we have a visitorId
        if (visitorId) {
          const ufilter = { day, visitorId, path };
          const uupdate = { $setOnInsert: { firstSeenAt: new Date(), month, year } };
          try {
            await UniqueVisit.updateOne(ufilter, uupdate, { upsert: true });
          } catch (e) {
            // duplicate key errors are expected when the unique index prevents duplicate insert
            if (e && e.code !== 11000) {
              console.warn("uniqueVisit error:", e?.message || e);
            }
          }
        }
      } catch (e) {
        console.warn("visitTracker db error:", e?.message || e);
      }
    });
  } catch (e) {
    console.warn("visitTracker error:", e?.message || e);
  } finally {
    return next();
  }
}
