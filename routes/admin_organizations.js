// routes/admin_organizations.js
import { Router } from "express";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import OrgInvite from "../models/orgInvite.js";
import { ensureAuth } from "../middleware/authGuard.js";

function ensureAdmin(req, res, next) {
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(s => s.trim().toLowerCase());
  if (!req.user || !adminEmails.includes(req.user.email.toLowerCase())) {
    return res.status(403).send("Admins only.");
  }
  next();
}

const router = Router();

//
// List all organizations
//
router.get("/admin/orgs", ensureAuth, ensureAdmin, async (req, res) => {
  const orgs = await Organization.find().sort({ createdAt: -1 }).lean();
  res.render("admin/org_list", { orgs });
});

//
// Create organization page
//
router.get("/admin/orgs/create", ensureAuth, ensureAdmin, (req, res) => {
  res.render("admin/org_create");
});

//
// Create organization POST
//
router.post("/admin/orgs/create", ensureAuth, ensureAdmin, async (req, res) => {
  const { name, slug, description } = req.body;
  const org = await Organization.create({
    name,
    slug,
    description,
    createdAt: new Date(),
  });
  res.redirect("/admin/orgs/" + org.slug);
});

//
// View organization
//
router.get("/admin/orgs/:slug", ensureAuth, ensureAdmin, async (req, res) => {
  const org = await Organization.findOne({ slug: req.params.slug }).lean();
  if (!org) return res.status(404).send("Org not found");

  const members = await OrgMembership.find({ org: org._id })
    .populate("user")
    .lean();

  res.render("admin/org_view", {
    org,
    members,
  });
});

//
// Edit organization page
//
router.get("/admin/orgs/:slug/edit", ensureAuth, ensureAdmin, async (req, res) => {
  const org = await Organization.findOne({ slug: req.params.slug }).lean();
  res.render("admin/org_edit", { org });
});

//
// Edit organization POST
//
router.post("/admin/orgs/:slug/edit", ensureAuth, ensureAdmin, async (req, res) => {
  const { name, description } = req.body;

  await Organization.findOneAndUpdate(
    { slug: req.params.slug },
    { name, description }
  );

  res.redirect("/admin/orgs/" + req.params.slug);
});




// simple admin check using ADMIN_EMAILS
function ensureAdminEmails(req, res, next) {
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!req.user || !req.user.email) {
    return res.status(403).send("Admins only");
  }
  if (!adminEmails.includes(req.user.email.toLowerCase())) {
    return res.status(403).send("Admins only");
  }
  next();
}

/**
 * ADMIN ORG DASHBOARD
 * GET /admin/orgs
 * Lists all organizations with actions:
 *  - Manage org
 *  - Manage modules
 *  - Add module
 *  - Open org dashboard (employee view)
 */
router.get("/admin/orgs", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const orgs = await Organization.find().sort({ createdAt: -1 }).lean();
    res.render("admin/orgs_index", { orgs });
  } catch (err) {
    console.error("[admin orgs index] error:", err && (err.stack || err));
    res.status(500).send("Failed to load organizations");
  }
});



export default router;
