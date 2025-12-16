// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { autoFetchAndScore } from "./utils/autoFetchAndScore.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// View engine
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Routes
app.get("/", (req, res) => res.redirect("/chat"));
app.get("/chat", (req, res) => res.render("chat"));

// 🧠 STREAMING CHAT ENDPOINT
app.post("/api/chat-stream", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  const dataPath = path.join(__dirname, "data", "scoi.json");
  if (!fs.existsSync(path.dirname(dataPath))) fs.mkdirSync(path.dirname(dataPath));

  let scoiData = {};
  if (fs.existsSync(dataPath)) {
    try {
      scoiData = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    } catch {
      scoiData = {};
    }
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // 🧮 SCOI calculation
  if (message.toLowerCase().includes("calculate scoi")) {
    const entity = message.replace(/calculate scoi for/i, "").trim().toLowerCase();
    let entityData = scoiData[entity];

    if (!entityData) {
      // Try fetching online data first
      res.write(`data: 🔍 Searching for real-world data about ${entity}...\n\n`);
      const fetched = await autoFetchAndScore(entity);

      if (fetched && fetched.success) {
        entityData = fetched.data;
        scoiData[entity] = { VI: entityData.VI, NE: entityData.NE, I: entityData.I };
        fs.writeFileSync(dataPath, JSON.stringify(scoiData, null, 2));

        res.write(`data: ✅ Found public data for ${entity.toUpperCase()}.\n\n`);
        res.write(`data: VI=${entityData.VI}, NE=${entityData.NE}, I=${entityData.I}\n\n`);
        res.write(`data: SCOI = (VI - NE) / I = ${entityData.SCOI}\n\n`);
        res.write(`data: Sources & reasoning:\n${fetched.sources}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      // Fallback: AI estimation even without data
      const estimatePrompt = `
You are the CRIPFCnt Systemic Intelligence Engine by Donald Mataranyika.
Estimate numeric values for "${entity}" in Zimbabwe:

1. Voluntary Impact (VI) — 0 to 100
2. Negative Externalities (NE) — 0 to 100
3. Income Dependence (I) — 0 to 100

Respond ONLY in JSON like {"VI": 78, "NE": 35, "I": 70}.
`;

      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: estimatePrompt }],
        });

        const jsonMatch = completion.choices[0].message.content.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error("No JSON returned");

        entityData = JSON.parse(jsonMatch[0]);
        scoiData[entity] = entityData;
        fs.writeFileSync(dataPath, JSON.stringify(scoiData, null, 2));

        const SCOI = ((entityData.VI - entityData.NE) / entityData.I).toFixed(2);
        res.write(`data: AI estimated SCOI for ${entity.toUpperCase()}.\n\n`);
        res.write(`data: VI=${entityData.VI}, NE=${entityData.NE}, I=${entityData.I}\n\n`);
        res.write(`data: SCOI = (VI - NE) / I = ${SCOI}\n\n`);
        res.write(`data: ${SCOI > 0 ? "Positive systemic contribution." : "Net systemic harm — recalibration needed."}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      } catch (err) {
        res.write(`data: ❌ Could not estimate SCOI for ${entity}.\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
    }

    // Use saved data
    const { VI, NE, I } = entityData;
    const SCOI = ((VI - NE) / I).toFixed(2);
    res.write(`data: Using saved data for ${entity.toUpperCase()}...\n\n`);
    res.write(`data: VI=${VI}, NE=${NE}, I=${I}\n\n`);
    res.write(`data: SCOI = (${VI} - ${NE}) / ${I} = ${SCOI}\n\n`);
    res.write(`data: ${SCOI > 0 ? "Positive systemic contribution." : "Net systemic harm — recalibration needed."}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  // 🧩 Qualitative → Numeric Conversion
  const qualMatch = message.match(/about (.+):/i);
  if (qualMatch) {
    const entity = qualMatch[1].toLowerCase();
    const description = message.replace(qualMatch[0], "").trim();

    const analysisPrompt = `
You are the CRIPFCnt Systemic Intelligence Engine by Donald Mataranyika.
From the following qualitative description of ${entity}, estimate numeric values for:
1. Voluntary Impact (VI) — 0 to 100
2. Negative Externalities (NE) — 0 to 100
3. Income Dependence (I) — 0 to 100

Respond ONLY in JSON like:
{"VI": 78, "NE": 35, "I": 70}

Description:
${description}
`;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: analysisPrompt }],
      });

      const data = JSON.parse(completion.choices[0].message.content);
      scoiData[entity] = data;
      fs.writeFileSync(dataPath, JSON.stringify(scoiData, null, 2));

      const SCOI = ((data.VI - data.NE) / data.I).toFixed(2);
      res.write(`data: AI analysis complete for ${entity.toUpperCase()}.\n\n`);
      res.write(`data: VI=${data.VI}, NE=${data.NE}, I=${data.I}\n\n`);
      res.write(`data: SCOI = (${data.VI} - ${data.NE}) / ${data.I} = ${SCOI}\n\n`);
      res.write(`data: ${SCOI > 0 ? "Positive systemic contribution." : "Net systemic harm — recalibration needed."}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    } catch (err) {
      res.write("data: ❌ Could not parse AI analysis.\n\n");
      res.write("data: [DONE]\n\n");
      return res.end();
    }
  }

  // 🧠 Default CRIPFCnt reasoning
  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    stream: true,
    messages: [
      {
        role: "system",
        content: `
You are a systemic intelligence assistant applying the CRIPFCnt framework by Donald Mataranyika.
Always interpret situations through:
- Voluntary Impact
- Negative Externalities
- Systemic Contribution (SCOI)
Ask for qualitative data if numeric data is insufficient.
      `,
      },
      { role: "user", content: message },
    ],
  });

  for await (const chunk of stream) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) res.write(`data: ${content}\n\n`);
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

// Start server
app.listen(process.env.PORT || 5000, () =>
  console.log(`✅ Server running at http://localhost:${process.env.PORT || 5000}/chat`)
);
