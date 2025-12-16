// server.js — CRIPFCnt SCOI Server (merged, updated)
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { engine } from "express-handlebars";
import mongoose from "mongoose";
import session from "express-session";
import MongoStore from "connect-mongo";
import passport from "passport";

// routes & utils
import trackRouter from "./routes/track.js";
import lmsRoutes from "./routes/lms.js";
import apiLmsRoutes from "./routes/api_lms.js";
import adminRoutes from "./routes/admin.js"; // merged admin (includes import/upload UI)
import User from "./models/user.js";
import configurePassport from "./config/passport.js";
import authRoutes from "./routes/authF.js";
import adminOrganizationRoutes from "./routes/admin_organizations.js";

import orgManagementRoutes from "./routes/org_management.js";



dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// friendly support contact (configurable via .env)
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@cripfcnt.com";

// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Compatibility shim: ensure res.render callbacks that call req.next won't crash
app.use((req, res, next) => {
  if (typeof req.next !== "function") req.next = next;
  next();
});

// Handlebars setup
app.engine("hbs", engine({ extname: ".hbs" }));
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// OpenAI client (optional)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ensure data folder exists
const dataPath = path.join(process.cwd(), "data", "scoi.json");
if (!fs.existsSync(path.dirname(dataPath))) fs.mkdirSync(path.dirname(dataPath), { recursive: true });

// --------- MONGOOSE connect (optional but useful for sessions) ----------
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error("❌ MONGODB_URI missing in .env — sessions will not be persisted to MongoDB.");
} else {
  mongoose.set("strictQuery", true);
  mongoose
    .connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch((err) => {
      console.error("❌ MongoDB connection failed:", err.message || err);
      // continue running (sessions will fail if DB required)
    });
}

// ---------- SESSIONS (must be before passport.initialize/session) ----------
const sessionSecret = process.env.SESSION_SECRET || "change_this_secret_for_dev_only";
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: mongoUri ? MongoStore.create({ mongoUrl: mongoUri }) : undefined,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
    },
  })
);

// ---------- PASSPORT setup ----------
configurePassport(); // expects config/passport.js to call passport.use(...) and serialize/deserialize
app.use(passport.initialize());
app.use(passport.session());

// mount auth routes first (so /auth is available when needed)
app.use("/auth", authRoutes);

// ADMIN (single mount for admin UI & import routes)
// Ensure routes/admin.js contains everything admin-related (user management + lms imports)
app.use("/admin", adminRoutes);

// API routes — keep LMS API on /api/lms so quiz UI fetches work: GET /api/lms/quiz and POST /api/lms/quiz/submit
app.use("/api/lms", apiLmsRoutes);

// Other API-level routes (tracking, etc.)
app.use("/api", trackRouter);

// Public LMS pages
app.use("/lms", lmsRoutes);
app.use(adminOrganizationRoutes);
app.use(orgManagementRoutes);
// small debug route to inspect current user (useful for testing)
app.get("/api/whoami", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.json({ authenticated: false });
});

// Helper: clean AI text (keeps minimal whitespace normalization)
function cleanAIText(text) {
  if (!text) return "";
  return String(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// Helper: format SCOI audit
function formatSCOI(entityData, entity) {
  const { visibility, contribution, ERF, adjustedSCOI, visibilityRationale, contributionRationale, scoiInterpretation, ERFRationale, commentary } = entityData;
  const rawSCOI = (contribution / visibility).toFixed(3);
  const adjusted = adjustedSCOI || (rawSCOI * ERF).toFixed(3);

  return `
### SCOI Audit — ${entity}

---

**1️⃣ Visibility — Score: ${visibility} / 10**  
**Rationale:**  
${visibilityRationale}

---

**2️⃣ Contribution — Score: ${contribution} / 10**  
**Rationale:**  
${contributionRationale}

---

**3️⃣ SCOI Calculation**  
SCOI = Contribution / Visibility = ${contribution} / ${visibility} = ${rawSCOI}  
**Interpretation:**  
${scoiInterpretation}

---

**4️⃣ Global Environment Adjustment — ERF: ${ERF}**  
**Rationale:**  
${ERFRationale}

---

**5️⃣ Adjusted SCOI**  
Adjusted SCOI = SCOI × ERF = ${rawSCOI} × ${ERF} = ${adjusted}

---

**6️⃣ Final CRIPFCnt Commentary:**  
${commentary}
`;
}

// Public pages
app.get("/", (req, res) => {
  res.render("website/index", { user: req.user || null });
});
app.get("/about", (req, res) => {
  res.render("website/about", { user: req.user || null });
});
app.get("/services", (req, res) => {
  res.render("website/services", { user: req.user || null });
});
app.get("/contact", (req, res) => {
  res.render("website/contact", { user: req.user || null });
});

// -------------------------------
// 🔹 ROUTE: Render Chat Page (protected)
// -------------------------------
import { ensureAuth } from "./middleware/authGuard.js";
app.get("/audit", ensureAuth, (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message: "Enter an organization or entity name to perform a live CRIPFCnt audit.",
    user: req.user || null,
  });
});

// -------------------------------
// 🔹 ROUTE: Chat Stream Endpoint (SSE streaming) with daily search credits
// (kept as-is from your original file)
// -------------------------------
app.post("/api/chat-stream", async (req, res) => {
  // Require authentication
  if (!(req.isAuthenticated && req.isAuthenticated())) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const user = req.user;
  const userId = user && user._id;
  const userEmail = (user && (user.email || "") || "").toLowerCase();

  // Admin bypass set
  const adminSet = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(s => String(s || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const isAdmin = userEmail && adminSet.has(userEmail);

  const DAILY_LIMIT = parseInt(process.env.SEARCH_DAILY_LIMIT || "3", 10);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // ensure keepAlive variable exists in outer scope so catch can clear it
  let keepAlive;

  try {
    // enforce daily limit for non-admins
    if (!isAdmin) {
      // Attempt to increment if already today and below limit
      const incResult = await User.findOneAndUpdate(
        { _id: userId, searchCountDay: today, searchCount: { $lt: DAILY_LIMIT } },
        { $inc: { searchCount: 1 }, $set: { lastLogin: new Date() } },
        { new: true }
      );

      if (!incResult) {
        // If not today's day (or not set), reset to today and set to 1
        const resetResult = await User.findOneAndUpdate(
          { _id: userId, $or: [{ searchCountDay: { $exists: false } }, { searchCountDay: { $ne: today } }] },
          { $set: { searchCountDay: today, searchCount: 1, lastLogin: new Date() } },
          { new: true }
        );

        if (!resetResult) {
          // both attempts failed - likely limit reached
          const current = await User.findById(userId);
          const used = (current && current.searchCountDay === today) ? (current.searchCount || 0) : 0;

          // compute next UTC midnight for a friendly reset time
          const resetAtDate = new Date();
          resetAtDate.setUTCHours(24, 0, 0, 0);
          const resetAtISO = resetAtDate.toISOString();

          return res.status(429).json({
            error: "Daily search limit reached",
            message: `You have reached your daily limit of ${DAILY_LIMIT} searches (used: ${used}). Please try again tomorrow or contact support.`,
            used,
            limit: DAILY_LIMIT,
            friendly: `You’ve used ${used} of ${DAILY_LIMIT} free audits today. Your free quota will reset at ${resetAtDate.toLocaleString('en-GB', { timeZone: 'UTC' })} (UTC). If you need more audits today, contact ${SUPPORT_EMAIL}.`,
            resetAt: resetAtISO,
            support: SUPPORT_EMAIL
          });
        }
        // resetResult success -> consumed 1 credit
      }
      // incResult success -> consumed 1 credit
    }

    // Setup SSE headers & keep-alive after credit has been consumed
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    keepAlive = setInterval(() => {
      try { res.write(":\n\n"); } catch (e) {}
    }, 15000);

    const { entity } = req.body || {};
    if (!entity) {
      res.write("data: ❌ Missing entity name.\n\n");
      clearInterval(keepAlive);
      return res.end();
    }

    const systemPrompt = `
You are the CRIPFCnt Audit Intelligence — trained under Donald Mataranyika’s civilization recalibration model.
Generate a single, clean, structured SCOI audit for the entity provided.
Follow this structure exactly:

1️⃣ Visibility — score and rationale
2️⃣ Contribution — score and rationale
3️⃣ SCOI = Contribution / Visibility (with brief interpretation)
4️⃣ Global Environment Adjustment — assign ERF (Environmental Resilience Factor)
5️⃣ Adjusted SCOI = SCOI × ERF
6️⃣ Final CRIPFCnt Commentary

Return the audit as readable text.
`;

    // call OpenAI (streaming)
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Perform a full CRIPFCnt SCOI Audit for: "${entity}". Include all scores, adjusted SCOI, and interpretive commentary.` },
      ],
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (!content) continue;

      const cleaned = cleanAIText(content);
      const lines = cleaned.split("\n");
      for (const line of lines) {
        res.write(`data: ${line}\n`);
      }
      res.write("\n");
    }

    clearInterval(keepAlive);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Stream / credits handler error:", err && (err.stack || err));
    try { if (keepAlive) clearInterval(keepAlive); } catch (e) {}

    const msg = String(err?.message || err || "unknown error").replace(/\r?\n/g, " ");
    if (!res.headersSent) {
      return res.status(500).json({ error: "Server error", detail: msg });
    } else {
      try {
        res.write(`data: ❌ Server error: ${msg}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (e) {
        console.error("Failed to send SSE error:", e);
      }
    }
  }
});

// -------------------------------
// 🔹 ROUTE: Static SCOI Audits (JSON)
// -------------------------------
const scoiAudits = [
  {
    organization: "Econet Holdings",
    visibility: 9.5,
    contribution: 7.0,
    rawSCOI: 0.74,
    resilienceFactor: 1.25,
    adjustedSCOI: 0.93,
    placementLevel: "Re-emerging Placement",
    interpretation: `Econet’s contribution remains high but has been visually overpowered by scale and routine visibility...`,
  },
];

app.get("/api/audits", (req, res) => {
  res.json({
    framework: "CRIPFCnt SCOI Audit System",
    author: "Donald Mataranyika",
    description: "Civilization-level audit system measuring organizational Visibility, Contribution, and Placement under global volatility.",
    formula: "Adjusted SCOI = Raw SCOI × Environmental Resilience Factor (ERF)",
    data: scoiAudits,
  });
});

app.get("/api/search-quota", (req, res) => {
  if (!(req.isAuthenticated && req.isAuthenticated())) return res.json({ authenticated: false, isAdmin: false, remaining: 0, limit: 0 });
  const user = req.user;
  const isAdmin = (new Set((process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()))).has((user.email || "").toLowerCase());
  const limit = parseInt(process.env.SEARCH_DAILY_LIMIT || "3", 10);
  const today = new Date().toISOString().slice(0,10);
  const used = (user.searchCountDay === today) ? (user.searchCount || 0) : 0;
  const remaining = isAdmin ? Infinity : Math.max(0, limit - used);
  return res.json({ authenticated: true, isAdmin, used, remaining, limit });
});

// -------------------------------
// 🟢 SERVER START
// -------------------------------
const PORT = process.env.PORT || 9000;
const HOST = process.env.HOST || "127.0.0.1";

app.listen(PORT, HOST, () => console.log(`🚀 Server running on http://${HOST}:${PORT}`));
