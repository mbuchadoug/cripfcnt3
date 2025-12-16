// server.js — cleaned & ordered

import dotenv from "dotenv";
dotenv.config();   


import express from "express";

import OpenAI from "openai";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { engine } from "express-handlebars";
import mongoose from "mongoose";
import session from "express-session";
import MongoStore from "connect-mongo";
import cookieParser from "cookie-parser";
import { ensureVisitorId } from "./middleware/visitorId.js";
import { visitTracker } from "./middleware/visits.js";







import passport from "passport";

import { ensureAuth } from "./middleware/authGuard.js";
import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";

import autoFetchAndScore from "./utils/autoFetchAndScore.js";
import configurePassport from "./config/passport.js";



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());

// Handlebars setup
// ---------- Handlebars setup (compatible with express@4 + express-handlebars@6) ----------


const hbsHelpers = {
  eq: (a, b) => String(a) === String(b),
  formatDate: (d) => {
    if (!d) return "";
    try { return new Date(d).toISOString().slice(0, 10); } catch (e) { return String(d); }
  },
};

app.engine(
  "hbs",
  engine({
    extname: ".hbs",
    defaultLayout: "main",
    layoutsDir: path.join(__dirname, "views", "layouts"),
    partialsDir: path.join(__dirname, "views", "partials"),
    helpers: hbsHelpers,
  })
);
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));



// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ensure data folder exists
const dataPath = path.join(process.cwd(), "data", "scoi.json");
if (!fs.existsSync(path.dirname(dataPath))) fs.mkdirSync(path.dirname(dataPath), { recursive: true });

// --------- MONGOOSE connect (optional but needed for Mongo-backed sessions) ----------
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error("❌ MONGODB_URI missing in .env — cannot start sessions/persistence.");
} else {
  mongoose.set("strictQuery", true);
  mongoose
    .connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch((err) => {
      console.error("❌ MongoDB connection failed:", err.message || err);
      // don't exit immediately — sessions will fail but server can run in limited mode
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
      secure: process.env.NODE_ENV === "production", // false for local dev
    },
  })
);

// ---------- PASSPORT setup ----------
configurePassport(); // must set up strategies & serialize/deserialize
app.use(passport.initialize());
app.use(passport.session());
// ... after passport.session() and before route handlers:
app.use(cookieParser());
app.use(ensureVisitorId);
app.use(visitTracker);


// expose auth routes (only once)
app.use("/auth", authRoutes);

// mount admin - requires sessions + passport to be configured earlier
app.use("/admin", adminRoutes);

// small debug route to see current user (helpful during testing)
app.get("/api/whoami", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.json({ authenticated: false });
});

// ----------------------
// Helper: non-destructive chunk cleaner
// ----------------------
function cleanChunkPreserveSpacing(text) {
  if (!text) return "";
  return String(text)
    // remove zero-width / hidden characters (these cause weird spacing/splits)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    // normalize CR to LF
    .replace(/\r/g, "");
}

// -------------------------------
// Helper: format SCOI audit (unchanged)
// -------------------------------
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

// -------------------------------
// Routes (unchanged)
// -------------------------------
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

app.get("/audit", ensureAuth, (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message: "Enter an organization or entity name to perform a live CRIPFCnt audit.",
    user: req.user || null,
  });
});

// -------------------------------
// Chat stream endpoint (SSE streaming — preserved behaviour)
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

      // Minimal, safe cleaning that preserves spacing/punctuation
      const cleaned = cleanChunkPreserveSpacing(content);

      // If chunk contains newlines, send each line prefixed by data: (SSE multi-line support)
      const lines = cleaned.split("\n");
      for (const line of lines) {
        // write each line as data: (empty line allowed)
        res.write(`data: ${line}\n`);
      }
      // end SSE event
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
// Static SCOI audits (JSON)
// -------------------------------
const scoiAudits = [
  // ... your existing data set ...
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


// Error handler (should be last middleware before app.listen)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500);
  if (req.headers.accept && req.headers.accept.indexOf("text/html") !== -1) {
    return res.send("<h1>Server error</h1><p>An internal error occurred. Check server logs.</p>");
  }
  res.json({ error: "Server error" });
});

app.listen(PORT, HOST, () => console.log(`🚀 Server running on http://${HOST}:${PORT}`));
