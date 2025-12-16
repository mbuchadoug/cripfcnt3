// middleware/authGuard.js
export function ensureAuth(req, res, next) {
  try {
    if (req.isAuthenticated && req.isAuthenticated()) {
      return next(); // user is logged in → allow
    }

    // save where the user was trying to go (session fallback)
    // prefer originalUrl (path + query)
    const dest = String(req.originalUrl || req.url || "/");

    // store in session too (best-effort)
    if (req.session) {
      try {
        req.session.returnTo = dest;
      } catch (e) {
        // ignore session errors
        console.warn("[ensureAuth] failed to set session.returnTo:", e && e.message);
      }
    }

    // Build a safe redirect URL to /auth/google and include a returnTo query param.
    // This is helpful when session cookie is not preserved or if you run multiple instances.
    const encoded = encodeURIComponent(dest);
    const authUrl = `/auth/google?returnTo=${encoded}`;

    return res.redirect(authUrl);
  } catch (err) {
    // In case something unexpected fails, fallback to sending user to auth page
    console.warn("[ensureAuth] unexpected error:", err && err.message);
    return res.redirect("/auth/google");
  }
}
