// routes/auth.js
import { Router } from "express";
import passport from "passport";

const router = Router();

// small helper to ensure returnTo is a safe same-origin path
function safeReturnTo(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  // decode and trim
  const decoded = decodeURIComponent(candidate).trim();
  // require it to start with a single slash and not include protocol or host
  // disallow double slashes at start (avoid //example.com)
  if (!decoded.startsWith("/")) return null;
  if (decoded.startsWith("//")) return null;
  // basic length check
  if (decoded.length > 2048) return null;
  // optionally you can further block paths like /logout or /auth routes:
  // if (decoded.startsWith('/auth')) return null;
  return decoded;
}

/**
 * GET /auth/google
 *
 * Optional query param: returnTo (URL-encoded path, e.g. /modules/1/quiz?foo=1)
 * If provided it will be saved to session and used after callback.
 *
 * If returnTo not present, we try referer header (path only) as last chance.
 */
router.get(
  "/google",
  (req, res, next) => {
    try {
      // 1) Explicit query param has highest priority
      if (req.query && req.query.returnTo) {
        const safe = safeReturnTo(String(req.query.returnTo));
        if (safe) {
          req.session.returnTo = safe;
          return next();
        }
      }

      // 2) If ensureAuth already set req.session.returnTo earlier, keep it
      if (req.session && req.session.returnTo) {
        return next();
      }

      // 3) Try referer header (extract path+search)
      const ref = req.get("referer");
      if (ref) {
        try {
          const u = new URL(ref);
          const candidate = (u.pathname || "/") + (u.search || "");
          const safe = safeReturnTo(candidate);
          if (safe) req.session.returnTo = safe;
        } catch (e) {
          // ignore parse errors
        }
      }
    } catch (e) {
      // don't fail auth because returnTo failed
      console.warn("[/auth/google] returnTo detection error:", e && e.message);
    }
    return next();
  },
  passport.authenticate("google", { scope: ["profile", "email"] })
);

/**
 * GET /auth/google/callback
 * passport authenticates and we redirect back to the saved path (or /audit)
 */
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    try {
      // Prefer session-stored returnTo (set by ensureAuth or /auth/google above)
      const raw = (req.session && req.session.returnTo) ? req.session.returnTo : null;
      // Clear it from session to avoid reuse
      if (req.session) delete req.session.returnTo;

      const safe = safeReturnTo(raw) || "/audit";
      return res.redirect(safe);
    } catch (e) {
      console.error("[/auth/google/callback] redirect error:", e && e.message);
      return res.redirect("/audit");
    }
  }
);

// Logout (keeps your existing behavior)
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
