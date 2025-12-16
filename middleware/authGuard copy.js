// middleware/authGuard.js
export function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next(); // user is logged in → allow
  }

  // save where the user was trying to go
  req.session.returnTo = req.originalUrl;

  // redirect to Google login
  return res.redirect("/auth/google");
}
