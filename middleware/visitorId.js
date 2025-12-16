// middleware/visitorId.js
import { randomUUID } from "crypto";

const COOKIE_NAME = process.env.VISITOR_COOKIE_NAME || "zimedufinder_vid";
const COOKIE_AGE = 1000 * 60 * 60 * 24 * 365; // 1 year

export function ensureVisitorId(req, res, next) {
  try {
    const existing = req.cookies && req.cookies[COOKIE_NAME];
    if (existing) {
      req.visitorId = existing;
      return next();
    }
    // generate v4-like id (crypto.randomUUID)
    const id = (typeof randomUUID === "function") ? randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
    // set cookie (httpOnly false so JS can read if needed; secure in prod)
    res.cookie(COOKIE_NAME, id, {
      maxAge: COOKIE_AGE,
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/"
    });
    req.visitorId = id;
  } catch (e) {
    // fallback: still continue without visitor id
    req.visitorId = null;
  } finally {
    return next();
  }
}
