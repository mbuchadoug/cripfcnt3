import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function autoFetchAndScore(entity) {
  try {
    const searchPrompt = `
Find real, public information on ${entity} — CSR activities, sustainability, environmental impact.
Provide a concise summary + up to 3 sources with URLs.
If nothing is found, respond "NO DATA FOUND".
`;

    const search = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: searchPrompt }],
    });

    const webData = search.choices[0].message.content;
    if (!webData || webData.includes("NO DATA FOUND")) return null;

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

    const raw = analysis.choices[0].message.content;
    const jsonMatch = raw.match(/\{.*\}/s);
    if (!jsonMatch) return null;

    const result = JSON.parse(jsonMatch[0]);

    // Save result
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
