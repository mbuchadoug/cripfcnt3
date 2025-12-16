// routes/auth.js
import { Router } from "express";
import passport from "passport";

const router = Router();

// small helper to ensure returnTo is a safe same-origin path
function safeReturnTo(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const decoded = decodeURIComponent(candidate).trim();
  if (!decoded.startsWith("/")) return null;
  if (decoded.startsWith("//")) return null;
  if (decoded.length > 2048) return null;
  // optional: block sensitive internal paths
  if (decoded.startsWith("/auth") || decoded.startsWith("/logout")) return null;
  return decoded;
}

// encode/decode for the state param — use base64url of the path only (no secrets)
function encodeState(returnTo) {
  try {
    if (!returnTo) return "";
    // base64url encode
    const b = Buffer.from(returnTo, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return b;
  } catch (e) {
    return "";
  }
}
function decodeState(state) {
  try {
    if (!state || typeof state !== "string") return null;
    // base64url -> base64
    const base64 = state.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((2 - state.length * 3) & 3);
    return Buffer.from(base64, "base64").toString("utf8");
  } catch (e) {
    return null;
  }
}

/**
 * GET /auth/google
 *
 * Optional query param: returnTo (URL-encoded path, e.g. /modules/1/quiz?foo=1)
 * We persist it to session *and* encode in the OAuth state param so it survives even if session persistence fails.
 */
router.get("/google", (req, res, next) => {
  try {
    // Determine the desired return target (priority: query.returnTo -> session.returnTo -> referer)
    let candidate = null;
    if (req.query && req.query.returnTo) candidate = String(req.query.returnTo);
    else if (req.session && req.session.returnTo) candidate = String(req.session.returnTo);
    else {
      const ref = req.get("referer");
      if (ref) {
        try {
          const u = new URL(ref);
          candidate = (u.pathname || "/") + (u.search || "");
        } catch (e) {
          // ignore
        }
      }
    }

    const safe = safeReturnTo(candidate) || null;

    // Save in session (best-effort)
    if (safe && req.session) {
      req.session.returnTo = safe;
      // attempt to save to store before redirecting to Google
      if (typeof req.session.save === "function") {
        req.session.save((err) => {
          if (err) console.warn("[/auth/google] session.save error:", err && err.message);
          // after attempt to save, start passport auth with state param
          const state = encodeState(safe);
          return passport.authenticate("google", { scope: ["profile", "email"], state })(req, res, next);
        });
        return;
      }
    }

    // No session.save or not saving — still send state param as fallback
    const state = encodeState(safe);
    return passport.authenticate("google", { scope: ["profile", "email"], state })(req, res, next);
  } catch (e) {
    console.warn("[/auth/google] error:", e && e.message);
    // fall back to starting auth without state (rare)
    return passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
  }
});

/**
 * GET /auth/google/callback
 * Passport authenticates then we redirect to the saved path (from state or session).
 */
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    try {
      // 1) First prefer state param (recommended)
      const rawState = req.query && req.query.state ? String(req.query.state) : null;
      const decoded = rawState ? decodeState(rawState) : null;

      // 2) If decoded state is a safe path, use it
      const fromState = decoded && safeReturnTo(decoded) ? decoded : null;

      // 3) If no state or invalid, fallback to session.returnTo
      const fromSession = (req.session && req.session.returnTo) ? safeReturnTo(req.session.returnTo) : null;

      // Clean the session key to prevent reuse
      if (req.session) {
        try { delete req.session.returnTo; } catch (e) {}
      }

      const final = fromState || fromSession || "/audit";

      // Debug log (remove in production)
      console.log("[/auth/google/callback] redirecting to:", { final, fromState, fromSession, sessionId: req.sessionID });

      return res.redirect(final);
    } catch (e) {
      console.error("[/auth/google/callback] redirect error:", e && e.message);
      return res.redirect("/audit");
    }
  }
);

// Logout
router.get("/logout", (req, res, next) => {
  req.logout(function (err) {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.redirect("/");
    });
  });
});

export default router;
