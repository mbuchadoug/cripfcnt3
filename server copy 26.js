// server.js — CRIPFCnt SCOI Server (merged, v6)
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
import trackRouter from "./routes/track.js";
// ...


// near top of server.js (after other imports)
import adminRoutes from "./routes/admin.js";

// ... after passport.initialize()/passport.session() and after app.use("/auth", authRoutes)


import autoFetchAndScore from "./utils/autoFetchAndScore.js";
import configurePassport from "./config/passport.js";
import authRoutes from "./routes/auth.js";
import { ensureAuth } from "./middleware/authGuard.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

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

// OpenAI client
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
configurePassport(); // expects config/passport.js to call passport.use(...)
app.use(passport.initialize());
app.use(passport.session());

// expose auth routes under /auth
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/api", trackRouter);
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
app.get("/audit", ensureAuth, (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message: "Enter an organization or entity name to perform a live CRIPFCnt audit.",
    user: req.user || null,
  });
});

// -------------------------------
// 🔹 ROUTE: Chat Stream Endpoint (SSE streaming)
// -------------------------------
app.post("/api/chat-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const keepAlive = setInterval(() => {
    try {
      res.write(":\n\n");
    } catch (e) {}
  }, 15000);

  try {
    const { entity } = req.body;
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

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Perform a full CRIPFCnt SCOI Audit for: "${entity}". Include all scores, adjusted SCOI, and interpretive commentary.` },
      ],
    });

    // Stream chunks from openai; clean minimally and send SSE-safe lines.
    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (!content) continue;

      const cleaned = cleanAIText(content);

      // If chunk contains newlines, send each line prefixed by data:
      const lines = cleaned.split("\n");
      for (const line of lines) {
        res.write(`data: ${line}\n`);
      }
      res.write("\n");
    }
  } catch (err) {
    console.error("Stream error:", err);
    const msg = String(err?.message || err || "unknown error").replace(/\r?\n/g, " ");
    res.write(`data: ❌ Server error: ${msg}\n\n`);
  } finally {
    clearInterval(keepAlive);
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// -------------------------------
// 🔹 ROUTE: Static SCOI Audits (JSON)
// -------------------------------
const scoiAudits = [
  // small sample; keep or replace with your data
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
  // add more items as desired
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

// -------------------------------
// 🟢 SERVER START
// -------------------------------
const PORT = process.env.PORT || 9000;
const HOST = process.env.HOST || "127.0.0.1";

app.listen(PORT, HOST, () => console.log(`🚀 Server running on http://${HOST}:${PORT}`));
