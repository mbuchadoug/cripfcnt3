import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -----------------------------
// Utility to clean AI text
// -----------------------------
function cleanAIText(text) {
  if (!text) return "";
  // Remove zero-width chars, non-ASCII, emojis
  let cleaned = text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/\n{2,}/g, "\n\n") // collapse multiple blank lines
    .trim();

  // Remove first line if it's garbage (contains mostly non-alphanumeric)
  const lines = cleaned.split("\n");
  if (lines[0] && /[^a-zA-Z0-9\s,.:;!?()]/.test(lines[0])) {
    lines.shift();
  }

  return lines.join("\n");
}

// -----------------------------
// Main function
// -----------------------------
export async function autoFetchAndScore(entity) {
  try {
    // -----------------------------
    // Step 1: Fetch online summary
    // -----------------------------
    const searchPrompt = `
Find real, public information on ${entity} — CSR activities, sustainability, environmental impact.
Provide a concise summary + up to 3 sources with URLs.
If nothing is found, respond "NO DATA FOUND".
`;

    const search = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: searchPrompt }],
    });

    let webData = search.choices[0].message.content;
    webData = cleanAIText(webData); // ✅ clean immediately

    if (!webData || webData.includes("NO DATA FOUND")) return null;

    // -----------------------------
    // Step 2: SCOI analysis
    // -----------------------------
    const analysisPrompt = `
You are the CRIPFCnt analyzer.
Based on this data about "${entity}", estimate:
1. Voluntary Impact (VI) 0-100
2. Negative Externalities (NE) 0-100
3. Income Dependence (I) 0-100

Provide a short summary explanation, and respond strictly in JSON:
{
  "VI": number,
  "NE": number,
  "I": number,
  "explanation": string,
  "sources": string
}

Data:
${webData}
`;

    const analysis = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: analysisPrompt }],
    });

    let rawAnalysis = analysis.choices[0].message.content;
    const finalClean = cleanAIText(rawAnalysis); // ✅ clean analysis output

    // -----------------------------
    // Step 3: Parse JSON
    // -----------------------------
    const jsonMatch = finalClean.match(/\{.*\}/s);
    if (!jsonMatch) return null;

    const result = JSON.parse(jsonMatch[0]);

    // -----------------------------
    // Step 4: Save to local JSON
    // -----------------------------
    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

    const dataPath = path.join(dataDir, "scoi.json");
    const existing = fs.existsSync(dataPath)
      ? JSON.parse(fs.readFileSync(dataPath, "utf8"))
      : {};

    existing[entity.toLowerCase()] = result;
    fs.writeFileSync(dataPath, JSON.stringify(existing, null, 2));

    return { success: true, data: result };
  } catch (err) {
    console.error("autoFetchAndScore error:", err);
    return null;
  }
}
