import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Clean AI text
function cleanAIText(text) {
  if (!text) return "";
  return text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\n{2,}/g, "\n\n").trim();
}

export async function autoFetchAndScore(entity) {
  try {
    // Step 1: Fetch public info
    const searchPrompt = `
Find public information on ${entity} — ESG, CSR, sustainability, environmental and social impact.
Return concise summary + 3 sources if possible. Respond "NO DATA FOUND" if none.
`;

    const search = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: searchPrompt }],
    });

    const webData = cleanAIText(search.choices[0].message.content);
    if (!webData || webData.includes("NO DATA FOUND")) return null;

    // Step 2: Convert to numeric SCOI
    const analysisPrompt = `
You are a CRIPFCnt analyzer. Based on this data about "${entity}", estimate:
1. Voluntary Impact (VI) 0-100
2. Negative Externalities (NE) 0-100
3. Income Dependence (I) 0-100

Provide:
- SCOI = (VI - NE) / I
- Short qualitative explanation
Respond strictly in JSON:
{"VI": number, "NE": number, "I": number, "SCOI": number, "explanation": string, "sources": string}

Data:
${webData}
`;

    const analysis = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: analysisPrompt }],
    });

    const raw = analysis.choices[0].message.content;
    const jsonMatch = raw.match(/\{.*\}/s);
    if (!jsonMatch) return null;

    const result = JSON.parse(jsonMatch[0]);
    result.explanation = cleanAIText(result.explanation || "");
    result.sources = cleanAIText(result.sources || webData);

    // Save locally
    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
    const dataPath = path.join(dataDir, "scoi.json");
    const existing = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, "utf8")) : {};
    existing[entity.toLowerCase()] = result;
    fs.writeFileSync(dataPath, JSON.stringify(existing, null, 2));

    return { success: true, data: result, sources: webData };
  } catch (err) {
    console.error("autoFetchAndScore error:", err);
    return null;
  }
}
