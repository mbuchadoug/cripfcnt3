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

// encode/decode for the state param — base64url of the path + optional joinToken
function encodeState(obj) {
  try {
    const json = JSON.stringify(obj || {});
    const b = Buffer.from(json, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return b;
  } catch (e) {
    return "";
  }
}
function decodeState(state) {
  try {
    if (!state || typeof state !== "string") return null;
    const base64 = state.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((2 - state.length * 3) & 3);
    const json = Buffer.from(base64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

/**
 * GET /auth/google
 * Accepts optional:
 *  - returnTo (path)
 *  - joinToken (organization invite token)
 *
 * We persist both to session and encode them in OAuth state as fallback.
 */
router.get("/google", (req, res, next) => {
  try {
    // determine returnTo candidate
    let candidate = null;
    if (req.query && req.query.returnTo) candidate = String(req.query.returnTo);
    else if (req.session && req.session.returnTo) candidate = String(req.session.returnTo);
    else {
      const ref = req.get("referer");
      if (ref) {
        try {
          const u = new URL(ref);
          candidate = (u.pathname || "/") + (u.search || "");
        } catch (e) {}
      }
    }
    const safe = safeReturnTo(candidate) || null;

    // joinToken (for org invite flow)
    const joinToken = req.query && req.query.joinToken ? String(req.query.joinToken) : (req.session && req.session.joinToken ? req.session.joinToken : null);

    // Save in session (best-effort)
    if (req.session) {
      if (safe) req.session.returnTo = safe;
      if (joinToken) req.session.joinToken = joinToken;
      // attempt to flush session store before redirect
      if (typeof req.session.save === "function") {
        req.session.save((err) => {
          if (err) console.warn("[/auth/google] session.save error:", err && err.message);
          const state = encodeState({ returnTo: safe, joinToken: joinToken || null });
          return passport.authenticate("google", { scope: ["profile", "email"], state })(req, res, next);
        });
        return;
      }
    }

    const state = encodeState({ returnTo: safe, joinToken: joinToken || null });
    return passport.authenticate("google", { scope: ["profile", "email"], state })(req, res, next);
  } catch (e) {
    console.warn("[/auth/google] error:", e && e.message);
    return passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
  }
});

/**
 * GET /auth/google/callback
 */
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  async (req, res) => {
    try {
      // 1) decode state if present
      const rawState = req.query && req.query.state ? String(req.query.state) : null;
      const decoded = rawState ? decodeState(rawState) : null;
      const fromState = decoded && decoded.returnTo ? safeReturnTo(decoded.returnTo) : null;
      const stateJoinToken = decoded && decoded.joinToken ? decoded.joinToken : null;

      // 2) session fallback
      const fromSession = (req.session && req.session.returnTo) ? safeReturnTo(req.session.returnTo) : null;
      const sessionJoinToken = req.session && req.session.joinToken ? req.session.joinToken : null;

      // 3) final targets
      const finalReturnTo = fromState || fromSession || "/audit";
      const finalJoinToken = stateJoinToken || sessionJoinToken || null;

      // cleanup session keys
      if (req.session) {
        try {
          delete req.session.returnTo;
          delete req.session.joinToken;
        } catch (e) {}
      }

      // If joinToken present, preserve it for next step (e.g. org join handler)
      if (finalJoinToken) {
        // store short-lived cookie or redirect to a join route with token (we prefer redirect)
        const redirectTo = `${finalReturnTo}${finalReturnTo.includes("?") ? "&" : "?"}joinToken=${encodeURIComponent(finalJoinToken)}`;
        console.log("[/auth/google/callback] redirecting (with joinToken) to:", redirectTo);
        return res.redirect(redirectTo);
      }

      console.log("[/auth/google/callback] redirecting to:", finalReturnTo);
      return res.redirect(finalReturnTo);
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
