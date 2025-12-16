// utils/autoFetchAndScore.js
import { TavilyClient } from "tavily";
import fs from "fs";
import path from "path";

const tavily = new TavilyClient({
  apiKey: process.env.TAVILY_API_KEY || "your_tavily_key_here",
});

// Load CRIPFCnt logic text
const logicPath = path.join(process.cwd(), "data", "cripfcnt.txt");
let cripfLogic = "";
try {
  cripfLogic = fs.readFileSync(logicPath, "utf8");
  console.log("✅ Loaded CRIPFCnt logic from data/cripfcnt.txt");
} catch (err) {
  console.warn("⚠️ Could not read cripfcnt.txt:", err.message);
}

/**
 * Generate SCOI-style audit using CRIPFCnt methodology
 */
export default async function autoFetchAndScore(entity, openai) {
  console.log(`🔍 Running CRIPFCnt SCOI audit for: ${entity}`);

  let tavilyResults;
  try {
    tavilyResults = await tavily.search({
      query: entity,
      search_depth: "advanced",
      max_results: 5,
    });
  } catch (error) {
    console.error("❌ Tavily fetch failed:", error.message);
  }

  const webText = tavilyResults?.results
    ?.map((r) => `${r.title}\n${r.snippet}`)
    .join("\n\n") || "No search results available.";

  const aiPrompt = `
You are the CRIPFCnt SCOI auditor (Donald Mataranyika methodology).

Framework summary:
${cripfLogic}

Task:
Conduct a SCOI Audit for "${entity}" based on the web context below.
Structure your reasoning using these sections:

1️⃣ Visibility (Capacity / Denominator)
- Describe reach, brand recognition, and systemic presence.
- Give a numeric Visibility Score out of 10.

2️⃣ Contribution (Structural Recalibration / Numerator)
- Evaluate the entity’s civilizational contribution, structural recalibration, responsibility, and placement.
- Give a numeric Contribution Score out of 10.

3️⃣ Global Environment Adjustment
- Assign an Environmental Resilience Factor (ERF) between 1.0 and 1.3 based on survival under economic, social, or technological stress.

4️⃣ SCOI Calculation:
Raw SCOI = Contribution / Visibility
Adjusted SCOI = Raw SCOI × ERF

5️⃣ Interpretation:
Define the placement category:
> 1.0 → Silent Over-Contributor
≈ 1.0 → Balanced Axis
< 1.0 → Grid Performer

6️⃣ CRIPFCnt Statement:
Give a poetic one-paragraph civilization interpretation.

Use this context to inform your audit:
${webText}
`;

  const response = await openai.responses.create({
    model: "gpt-4o-mini",
    input: aiPrompt,
  });

  const summary = response.output?.[0]?.content?.[0]?.text || "No summary generated.";

  // Parse approximate numbers (AI will provide them naturally)
  const num = (label) => {
    const m = summary.match(new RegExp(`${label}[^\\d]*(\\d+(\\.\\d+)?)`, "i"));
    return m ? parseFloat(m[1]) : null;
  };

  const visibility = num("Visibility") || 8;
  const contribution = num("Contribution") || 7;
  const erf = num("ERF") || 1.1;
  const rawSCOI = +(contribution / visibility).toFixed(2);
  const adjustedSCOI = +(rawSCOI * erf).toFixed(2);

  let placementLevel =
    adjustedSCOI > 1.0
      ? "Silent Over-Contributor"
      : adjustedSCOI >= 0.95
      ? "Balanced Axis"
      : "Grid Performer";

  return {
    entity,
    visibility,
    contribution,
    rawSCOI,
    adjustmentFactor: erf,
    adjustedSCOI,
    placementLevel,
    summary,
    interpretation: extractSection(summary, "Interpretation"),
    statement: extractSection(summary, "Statement"),
    source: "tavily",
    urls: tavilyResults?.results?.map((r) => r.url) || [],
  };
}

/**
 * Extract specific section text from the AI summary
 */
function extractSection(text, keyword) {
  const re = new RegExp(`${keyword}[:\\-\\s]+([\\s\\S]*?)(?=\\n\\d|$)`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}
