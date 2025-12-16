import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { autoFetchAndScore } from "./utils/autoFetchAndScore.js";

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper: clean AI text
function cleanAIText(text) {
  if (!text) return "";
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

app.get("/", (req, res) => res.redirect("/chat"));
app.get("/chat", (req, res) => res.render("chat"));
app.post("/api/chat-stream", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const dataPath = path.join(__dirname, "data", "scoi.json");
  if (!fs.existsSync(path.dirname(dataPath))) fs.mkdirSync(path.dirname(dataPath));

  let scoiData = {};
  if (fs.existsSync(dataPath)) {
    try { scoiData = JSON.parse(fs.readFileSync(dataPath, "utf8")); } 
    catch { scoiData = {}; }
  }

  const lowerMsg = message.toLowerCase();

  // -----------------------------
  // SCOI calculation
  // -----------------------------
  if (lowerMsg.includes("calculate scoi")) {
    const entity = message.replace(/calculate scoi for/i, "").trim().toLowerCase();
    let entityData = scoiData[entity];

    if (!entityData) {
      // Try online fetch
      res.write(`data: 🔍 Searching for ${entity} online...\n\n`);
      const fetched = await autoFetchAndScore(entity);

      if (fetched && fetched.success) {
        entityData = fetched.data;
        scoiData[entity] = entityData;
        fs.writeFileSync(dataPath, JSON.stringify(scoiData, null, 2));

        const VI = Number(entityData.VI);
        const NE = Number(entityData.NE);
        const I = Number(entityData.I);
        const SCOI = ((VI - NE) / I).toFixed(2);

        res.write(`data: ✅ Summary for ${entity.toUpperCase()}:\n\n`);
        res.write(`data: ${cleanAIText(entityData.explanation)}\n\n`);
        res.write(`data: VI=${VI}, NE=${NE}, I=${I}\n`);
        res.write(`data: SCOI = (${VI} - ${NE}) / ${I} = ${SCOI}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      // Ask user for qualitative input if no data
      const prompt = `I couldn’t find online data for ${entity}. Please describe:
- Voluntary positive impacts
- Negative externalities
- Dependence on income/profit`;

      res.write(`data: ${cleanAIText(prompt)}\n\n`);
      res.write("data: [WAITING_FOR_QUALITATIVE_INPUT]\n\n");
      return res.end();
    }

    // -----------------------------
    // Use saved data
    // -----------------------------
    const VI = Number(entityData.VI);
    const NE = Number(entityData.NE);
    const I = Number(entityData.I);
    const SCOI = ((VI - NE) / I).toFixed(2);

    res.write(`data: Using saved data for ${entity.toUpperCase()}:\n\n`);
    if (entityData.explanation) {
      res.write(`data: ${cleanAIText(entityData.explanation)}\n\n`);
    }
    res.write(`data: VI=${VI}, NE=${NE}, I=${I}\n`);
    res.write(`data: SCOI = (${VI} - ${NE}) / ${I} = ${SCOI}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  // -----------------------------
  // Unknown command
  // -----------------------------
  res.write(`data: ❌ Unknown command. Use "Calculate SCOI for [company]"\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});


app.listen(process.env.PORT || 5000, () =>
  console.log(`✅ Server running at http://localhost:${process.env.PORT || 5000}/chat`)
);
