// server.js — CRIPFCnt SCOI Server (v5: Merged & Structured)

import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { engine } from "express-handlebars";
import autoFetchAndScore from "./utils/autoFetchAndScore.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Handlebars setup
app.engine("hbs", engine({ extname: ".hbs" }));
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ensure data folder exists
const dataPath = path.join(process.cwd(), "data", "scoi.json");
if (!fs.existsSync(path.dirname(dataPath))) fs.mkdirSync(path.dirname(dataPath), { recursive: true });

// Helper: clean AI text
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


app.get("/", (req, res) => {
res.render('website/index')
});

app.get("/about", (req, res) => {
res.render('website/about')
});

app.get("/services", (req, res) => {
res.render('website/services')
});

app.get("/contact", (req, res) => {
res.render('website/contact')
});


// -------------------------------
// 🔹 ROUTE: Render Chat Page
// -------------------------------
app.get("/audit", (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message: "Enter an organization or entity name to perform a live CRIPFCnt audit.",
  });
});

// -------------------------------
// 🔹 ROUTE: Chat Stream Endpoint
// -------------------------------
// -------------------------------
// 🔹 ROUTE: Chat Stream Endpoint (Clean, Structured Output)
// -------------------------------
app.post("/api/chat-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const keepAlive = setInterval(() => {
    try { res.write(":\n\n"); } catch (e) {}
  }, 15000);

  try {
    const { entity } = req.body;
    if (!entity) {
      res.write("data: ❌ Missing entity name.\n\n");
      clearInterval(keepAlive);
      return res.end();
    }

    // System prompt instructs AI to return clean structured SCOI
    const systemPrompt = `
You are the CRIPFCnt Audit Intelligence — trained under Donald Mataranyika’s civilization recalibration model.
Generate a **single, clean, structured SCOI audit** for the entity provided.
Follow this structure exactly:

1️⃣ Visibility — score and rationale
2️⃣ Contribution — score and rationale
3️⃣ SCOI = Contribution / Visibility (with brief interpretation)
4️⃣ Global Environment Adjustment — assign ERF (Environmental Resilience Factor)
5️⃣ Adjusted SCOI = SCOI × ERF
6️⃣ Final CRIPFCnt Commentary

Return the audit **as readable text**, without splitting words or repeating sections.
Do not include any placeholders, repeated headers, or HTML/markdown except basic headings.
`;

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Perform a full CRIPFCnt SCOI Audit for: "${entity}". Include all scores, adjusted SCOI, and interpretive commentary.`
        },
      ],
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        // Write each chunk as SSE
        res.write(`data: ${content}\n\n`);
      }
    }
  } catch (err) {
    console.error(err);
    res.write(`data: ❌ Server error: ${err.message}\n\n`);
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
  {
    organization: "Econet Holdings",
    visibility: 9.5,
    contribution: 7.0,
    rawSCOI: 0.74,
    resilienceFactor: 1.25,
    adjustedSCOI: 0.93,
    placementLevel: "Re-emerging Placement",
    interpretation: `Econet’s contribution remains high but has been visually overpowered by scale and routine visibility.
Yet in global context, surviving and innovating under structural turbulence lifts it close to placement again.
Its adjusted SCOI of 0.93 restores it as a responsible civilization actor — not yet prophetic, but far from grid collapse.`,
  },
  {
    organization: "Nyaradzo Group",
    visibility: 9.5,
    contribution: 8.3,
    rawSCOI: 0.87,
    resilienceFactor: 1.20,
    adjustedSCOI: 1.04,
    placementLevel: "Silent Over-Contributor",
    interpretation: `Nyaradzo’s visibility has grown faster than its recalibration rate, but its consistent contribution amid economic chaos moves it back above equilibrium.
A 1.04 adjusted SCOI marks it as a silent over-contributor — carrying civilization weight beyond recognition.`,
  },
  {
    organization: "Apple Inc.",
    visibility: 10.0,
    contribution: 7.8,
    rawSCOI: 0.78,
    resilienceFactor: 1.15,
    adjustedSCOI: 0.90,
    placementLevel: "Visibility-Heavy Performer",
    interpretation: `Apple’s discipline itself became contribution.
What once looked like stagnation now reads as moderation — the human job of balancing visibility with continuity.
Its adjusted SCOI of 0.90 places it as the grid’s stabilizing anchor in a collapsing digital civilization.`,
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



// -------------------------------
// 🟢 SERVER START
// -------------------------------
const PORT = process.env.PORT || 9000;
//app.listen(PORT, () => console.log(`🚀 CRIPFCnt Audit Server running on port ${PORT}`));


app.listen(PORT, '127.0.0.1', () => console.log(`🚀 Server running on ${PORT}`));
