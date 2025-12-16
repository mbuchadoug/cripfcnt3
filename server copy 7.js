import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import { engine } from "express-handlebars";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Handlebars setup
app.engine("hbs", engine({ extname: ".hbs" }));
app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Render chat page
app.get("/", (req, res) => {
  res.render("chat", {
    title: "CRIPFCnt SCOI Audit",
    message:
      "Enter an organization or entity name to perform a live CRIPFCnt SCOI audit powered by OpenAI.",
  });
});

// SCOI stream endpoint
app.post("/api/chat-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const { entity } = req.body;
    if (!entity) {
      res.write("data: Missing entity name.\n\n");
      return res.end();
    }

    const systemPrompt = `
You are the CRIPFCnt SCOI Auditor (Donald Mataranyika methodology). 
Generate a cleanly formatted SCOI audit for the entity. 

Use **numbered sections** and headings exactly like this:

SCOI Audit — <Entity>

1️⃣ Visibility — Score: <score> / 10
Rationale:
<Explain visibility in concise paragraphs.>
Note: <Any limitations or considerations.>

2️⃣ Contribution — Score: <score> / 10
Rationale:
<Explain contribution in concise paragraphs.>
Limitations: <Challenges or gaps.>

3️⃣ SCOI Calculation
SCOI = Contribution / Visibility = <Contribution> / <Visibility> = <Raw SCOI>
Interpretation:
<Interpretation of the SCOI score.>

4️⃣ Global Environment Adjustment — ERF: <ERF>
Rationale:
<Explain environmental adjustment and context.>

5️⃣ Adjusted SCOI
Adjusted SCOI = SCOI × ERF = <Raw SCOI> × <ERF> = <Adjusted SCOI>

6️⃣ Final CRIPFCnt Commentary:
<Poetic final commentary on the entity's overall performance.>

**Preserve line breaks, spacing, and headings. Do not split words unnaturally.**
`;

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Generate SCOI Audit for "${entity}" with all sections clearly formatted.`
        },
      ],
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        res.write(`data: ${content}\n\n`);
      }
    }

  } catch (err) {
    console.error(err);
    res.write(`data: ❌ Error: ${err.message}\n\n`);
  } finally {
    res.end();
  }
});


// Render chat page
app.get("/result", (req, res) => {
  res.render("result", {
    title: "CRIPFCnt SCOI Audit",
    message:
      "Enter an organization or entity name to perform a live CRIPFCnt SCOI audit powered by OpenAI.",
  });
});

app.post('/result', (req, res) => {
  const { organization, visibility, contribution, ERF } = req.body;

  const rawSCOI = (contribution / visibility).toFixed(2);
  const adjustedSCOI = (rawSCOI * ERF).toFixed(2);

  let rawInterpretation = "";
  if (rawSCOI > 1) rawInterpretation = "Silent Over-Contributor — contribution exceeds recognition.";
  else if (rawSCOI < 1) rawInterpretation = "Grid Performer — visibility exceeds recalibration.";
  else rawInterpretation = "Balanced Axis — equilibrium between visibility and recalibration.";

  res.render('result', {
    organization,
    year: 2025,
    visibility,
    contribution,
    ERF,
    rawSCOI,
    adjustedSCOI,
    rawInterpretation,
    visibilityNotes: "Entity visibility across social, digital, and industrial grids.",
    contributionNotes: "Evaluated contribution to structural civilization recalibration.",
    ERFNotes: "Environment factor based on market complexity and resilience performance.",
    commentary: "In the theater of civilization, placement defines endurance more than visibility. This audit reflects the entity’s resilience against systemic volatility."
  });
});


const PORT = process.env.PORT || 9000;
app.listen(PORT, () => {
  console.log(`🚀 CRIPFCnt Audit Server running on port ${PORT}`);
});
