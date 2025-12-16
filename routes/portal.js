import { Router } from "express";
import OrgMembership from "../models/orgMembership.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

function isPlatformAdmin(req) {
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  return !!(
    req.user &&
    req.user.email &&
    admins.includes(req.user.email.toLowerCase())
  );
}

router.get("/portal", ensureAuth, async (req, res) => {
  try {
    // 1️⃣ PLATFORM ADMIN
    if (isPlatformAdmin(req) || req.user.role === "super_admin") {
      return res.redirect("/admin/orgs");
    }

    // 2️⃣ ORG MEMBER (employee / org_admin / manager)
    const membership = await OrgMembership.findOne({ user: req.user._id })
      .populate("org")
      .lean();

    if (membership && membership.org) {
      return res.redirect(`/org/${membership.org.slug}/dashboard`);
    }

    // 3️⃣ NOT CLASSIFIED → back to website
    return res.redirect("/");
  } catch (err) {
    console.error("[/portal] error:", err);
    return res.redirect("/");
  }
});

export default router;
