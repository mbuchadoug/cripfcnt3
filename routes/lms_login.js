import { Router } from "express";
import Organization from "../models/organization.js";
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

router.get("/lms/login", ensureAuth, async (req, res) => {
  try {
    /** 1️⃣ PLATFORM ADMIN → GLOBAL ADMIN */
    if (isPlatformAdmin(req) || req.user.role === "super_admin") {
      return res.redirect("/admin/orgs");
    }

    /** 2️⃣ ORG MEMBER (employee / org_admin / manager) */
    const membership = await OrgMembership.findOne({ user: req.user._id })
      .populate("org")
      .lean();

    if (!membership || !membership.org) {
      return res.status(403).send("You are not assigned to any organization.");
    }

    return res.redirect(`/org/${membership.org.slug}/dashboard`);
  } catch (err) {
    console.error("[lms/login] error:", err);
    return res.status(500).send("Login routing failed");
  }
});

export default router;
