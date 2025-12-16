// server.js — CRIPFCnt SCOI Server (v3: Tavily + OpenAI Integration)

import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs";
import path from "path";
import hbs from "hbs";
import { fileURLToPath } from "url";
import autoFetchAndScore from "./utils/autoFetchAndScore.js"; // ✅ new integration
import OpenAI from "openai"; // ✅ OpenAI SDK

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// -----------------------------
// Handlebars setup
// -----------------------------
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));
hbs.registerPartials(path.join(__dirname, "views", "partials"));

// -----------------------------
// Ensure data directory exists
// -----------------------------
const dataPath = path.join(process.cwd(), "data", "scoi.json");
if (!fs.existsSync(path.dirname(dataPath))) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
}

// -----------------------------
// OpenAI initialization
// -----------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------
// Helper: clean AI text
// -----------------------------
function cleanAIText(text, label = "") {
  if (!text) return "";
  let cleaned = String(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const lines = cleaned.split(/\n+/);
  if (lines[0] && !/^[A-Z][a-z]+(\s+[a-z]+)/.test(lines[0])) {
    console.log(`🧹 Removed garbled first line for: ${label || "unknown"}`);
    lines.shift();
  }
  return lines.join("\n").trim();
}

// -----------------------------
// SSE endpoint: /api/chat-stream
// -----------------------------
app.post("/api/chat-stream", async (req, res) => {
  try {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const keepAlive = setInterval(() => {
      try {
        res.write(":\n\n");
      } catch (e) {}
    }, 15000);

    let { entity, message } = req.body || {};
    if (!entity && typeof message === "string") {
      const m = message.match(/calculate scoi for\s+(.+)/i);
      if (m) entity = m[1].trim();
    }

    if (!entity) {
      res.write(`data: ❌ Missing 'entity' (send { "entity": "Lafarge" })\n\n`);
      res.write("data: [DONE]\n\n");
      clearInterval(keepAlive);
      return res.end();
    }

    const label = entity;
    res.write(`data: 🔍 Fetching and analyzing ${label}...\n\n`);

    // Read cache if exists
    let existingData = {};
    try {
      if (fs.existsSync(dataPath)) {
        existingData = JSON.parse(fs.readFileSync(dataPath, "utf8") || "{}");
      }
    } catch (e) {
      console.error("Failed to read scoi.json:", e);
    }

    let entityData = existingData[entity.toLowerCase()];

    // Fetch if not cached
    if (!entityData) {
      let fetched;
      try {
        fetched = await autoFetchAndScore(entity, openai); // ✅ integrated call
      } catch (err) {
        console.error("autoFetchAndScore threw:", err);
        fetched = null;
      }

      if (!fetched) {
        const prompt = `I couldn't find online data for ${entity}. Please describe:
- Voluntary positive impacts
- Negative externalities
- Dependence on income/profit`;
        res.write(`data: ${cleanAIText(prompt, label)}\n\n`);
        res.write("data: [WAITING_FOR_QUALITATIVE_INPUT]\n\n");
        clearInterval(keepAlive);
        return res.end();
      }

      // Structure data
      entityData = {
        VI: Math.floor(Math.random() * 10), // placeholder scoring logic
        NE: Math.floor(Math.random() * 10),
        I: Math.floor(Math.random() * 10) || 1,
        explanation: fetched.summary,
        sources: fetched.results.map((r) => r.url).join("\n"),
      };

      // Cache result
      existingData[entity.toLowerCase()] = entityData;
      try {
        fs.writeFileSync(dataPath, JSON.stringify(existingData, null, 2));
      } catch (e) {
        console.error("Failed to write scoi.json:", e);
      }
    }

    // Calculate SCOI
    const VI = Number(entityData.VI ?? 0);
    const NE = Number(entityData.NE ?? 0);
    const I = Number(entityData.I ?? 1) || 1;
    const SCOI = ((VI - NE) / I).toFixed(2);

    res.write(`data: ✅ Summary for ${entity.toUpperCase()}:\n\n`);
    res.write(`data: ${cleanAIText(entityData.explanation, label)}\n\n`);
    if (entityData.sources)
      res.write(`data: 📚 Sources:\n${cleanAIText(entityData.sources)}\n\n`);
    res.write(`data: VI=${VI}, NE=${NE}, I=${I}\n`);
    res.write(`data: SCOI = (${VI} - ${NE}) / ${I} = ${SCOI}\n\n`);
    res.write("data: [DONE]\n\n");

    clearInterval(keepAlive);
    return res.end();
  } catch (err) {
    console.error("Unhandled error in /api/chat-stream:", err);
    try {
      res.write(`data: ❌ Server error: ${err.message || "unknown"}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (e) {}
  }
});

// -----------------------------
// Routes
// -----------------------------
app.get("/", (req, res) => res.send("✅ CRIPFCnt AI SCOI server is running!"));

app.get("/chat", (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Chat",
    message: "Enter a company name to calculate its SCOI",
  });
});

// -----------------------------
// Start server
// -----------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
