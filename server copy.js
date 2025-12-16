import dotenv from "dotenv";
dotenv.config();
import express from "express";
import cors from "cors";
//import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { autoFetchAndScore } from "./utils/autoFetchAndScore.js";

//dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

/*const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});*/

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // now loaded from .env
});


// Helper to clean AI text
function cleanAIText(text) {
  if (!text) return "";
  return text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\n{2,}/g, "\n\n").trim();
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

  // 🧮 SCOI calculation
  if (lowerMsg.includes("calculate scoi")) {
    const entity = message.replace(/calculate scoi for/i, "").trim().toLowerCase();
    const entityData = scoiData[entity];

    if (!entityData) {
      // Try autoFetchAndScore
      res.write(`data: 🔍 Searching online for ${entity}...\n\n`);
      const fetched = await autoFetchAndScore(entity);

      if (fetched && fetched.success) {
        const { VI, NE, I, SCOI } = fetched.data;
        res.write(`data: ✅ Found public data for ${entity.toUpperCase()}.\n\n`);
        res.write(`data: VI=${VI}, NE=${NE}, I=${I}\n\n`);
        res.write(`data: SCOI = (VI - NE) / I = ${SCOI}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      // Ask for qualitative input if no data
      const prompt = `I couldn’t find online data for ${entity}.
Please describe ${entity}'s systemic behavior:
- Voluntary positive impacts
- Negative externalities
- Dependence on income/profit`;

      res.write(`data: ${prompt}\n\n`);
      res.write("data: [WAITING_FOR_QUALITATIVE_INPUT]\n\n");
      return res.end();
    }

    const { VI, NE, I } = entityData;
    const scoi = ((VI - NE) / I).toFixed(2);
    res.write(`data: Using saved data for ${entity.toUpperCase()}...\n\n`);
    res.write(`data: SCOI = (${VI} - ${NE}) / ${I} = ${scoi}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  // 🧩 Qualitative → Numeric Conversion
  const qualMatch = message.match(/about (.+):/i);
  if (qualMatch) {
    const entity = qualMatch[1].toLowerCase();
    const description = message.replace(qualMatch[0], "").trim();

    const analysisPrompt = `
You are the CRIPFCnt Systemic Intelligence Engine.
Estimate numeric values for:
1. Voluntary Impact (VI) 0-100
2. Negative Externalities (NE) 0-100
3. Income Dependence (I) 0-100

Respond ONLY in JSON: {"VI": number, "NE": number, "I": number}

Description:
${description}
`;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: analysisPrompt }],
      });

      const data = JSON.parse(completion.choices[0].message.content);
      const { VI, NE, I } = data;
      scoiData[entity] = { VI, NE, I };
      fs.writeFileSync(dataPath, JSON.stringify(scoiData, null, 2));
      const scoi = ((VI - NE) / I).toFixed(2);

      res.write(`data: AI analysis complete for ${entity.toUpperCase()}.\n\n`);
      res.write(`data: VI=${VI}, NE=${NE}, I=${I}\n\n`);
      res.write(`data: SCOI = (${VI} - ${NE}) / ${I} = ${scoi}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    } catch (err) {
      res.write(`data: ❌ Error analyzing qualitative input: ${err.message}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
  }

  // 🧠 General questions (e.g., "what is SCOI")
  try {
    const explanation = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are the CRIPFCnt Systemic Intelligence Engine.
Explain SCOI clearly in paragraphs. No splitting of words.
Include Voluntary Impact, Negative Externalities, and Systemic Contribution.
          `,
        },
        { role: "user", content: message },
      ],
    });

    const text = cleanAIText(explanation.choices[0].message.content);
    res.write(`data: ${text}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  } catch (err) {
    res.write(`data: ❌ Error generating explanation: ${err.message}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }
});

app.listen(process.env.PORT || 5000, () =>
  console.log(`✅ Server running at http://localhost:${process.env.PORT || 5000}/chat`)
);
