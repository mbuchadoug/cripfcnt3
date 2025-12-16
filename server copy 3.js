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

// Helper to clean AI text
function cleanAIText(text) {
  if (!text) return "";
  return text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\n{2,}/g, "\n\n").trim();
}

// ROUTES
app.get("/", (req, res) => res.redirect("/chat"));
app.get("/chat", (req, res) => res.render("chat"));

// SCOI CALCULATOR
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

  // Detect company name from message
  const company = message.toLowerCase().replace(/calculate scoi for/i, "").trim();
  if (!company) {
    res.write("data: ❌ Please provide a company name.\n\n");
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  let entityData = scoiData[company];

  if (!entityData) {
    // Try fetching online or AI estimation
    res.write(`data: 🔍 Searching for data about ${company}...\n\n`);
    const fetched = await autoFetchAndScore(company);

    if (fetched && fetched.success) {
      entityData = fetched.data;
      scoiData[company] = entityData;
      fs.writeFileSync(dataPath, JSON.stringify(scoiData, null, 2));
    } else {
      // Ask AI to estimate numeric SCOI
      const estimatePrompt = `
You are the CRIPFCnt Systemic Intelligence Engine.
Estimate numeric values for "${company}":

1. Voluntary Impact (VI) 0-100
2. Negative Externalities (NE) 0-100
3. Income Dependence (I) 0-100

Provide a short qualitative explanation.
Respond strictly in JSON: {"VI": number, "NE": number, "I": number, "explanation": string}
`;

      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: estimatePrompt }],
        });

        const jsonMatch = completion.choices[0].message.content.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error("No JSON returned");

        entityData = JSON.parse(jsonMatch[0]);
        scoiData[company] = entityData;
        fs.writeFileSync(dataPath, JSON.stringify(scoiData, null, 2));
      } catch (err) {
        res.write(`data: ❌ Could not estimate SCOI for ${company}.\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
    }
  }

  const { VI, NE, I, explanation, sources } = entityData;
  const SCOI = ((VI - NE) / I).toFixed(2);

  const summary = `
📊 SCOI for ${company.toUpperCase()}:

Voluntary Impact (VI): ${VI}
Negative Externalities (NE): ${NE}
Income Dependence (I): ${I}
SCOI = (${VI} - ${NE}) / ${I} = ${SCOI}

Explanation: ${explanation || "No explanation provided."}

${sources ? `Sources:\n${sources}` : ""}
`;

  // Stream summary line by line (typewriter effect)
  for (const line of summary.split("\n")) res.write(`data: ${line}\n\n`);
  res.write("data: [DONE]\n\n");
});

app.listen(process.env.PORT || 5000, () =>
  console.log(`✅ Server running at http://localhost:${process.env.PORT || 5000}/chat`)
);
