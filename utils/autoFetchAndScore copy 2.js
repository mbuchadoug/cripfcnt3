import dotenv from "dotenv";
dotenv.config();
// utils/autoFetchAndScore.js
//import OpenAI from "openai";
import fs from "fs";
import path from "path";


import OpenAI from "openai";


/*const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});*/
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // now loaded from .env
});


export async function autoFetchAndScore(entity) {
  try {
    // 🕸️ Step 1: Web search for sustainability/ESG data
    const searchPrompt = `
Find real, public information on ${entity} — specifically:
- ESG data, sustainability reports, CSR activities
- Environmental impact, community contribution, governance quality

Return concise summary + list of 3 reliable sources with URLs.
If nothing is found, respond with "NO DATA FOUND".
`;

    const search = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: searchPrompt }],
    });

    const webData = search.choices[0].message.content;
    if (!webData || webData.includes("NO DATA FOUND")) return null;

    // 🧮 Step 2: Convert qualitative web data to CRIPFCnt numeric values
    const analysisPrompt = `
You are the CRIPFCnt analyzer. Based on this data about "${entity}", estimate:
1. Voluntary Impact (VI) — 0 to 100
2. Negative Externalities (NE) — 0 to 100
3. Income Dependence (I) — 0 to 100

Respond strictly in JSON: {"VI": number, "NE": number, "I": number}
Then, briefly explain your reasoning and list source credibility scores (0–1).

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

    // 🧾 Save the result
    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
    const dataPath = path.join(dataDir, "scoi.json");

    const existing = fs.existsSync(dataPath)
      ? JSON.parse(fs.readFileSync(dataPath, "utf8"))
      : {};

    existing[entity.toLowerCase()] = result;
    fs.writeFileSync(dataPath, JSON.stringify(existing, null, 2));

    // ⚙️ Step 3: Calculate SCOI
    const { VI, NE, I } = result;
    const SCOI = ((VI - NE) / I).toFixed(2);

    return {
      success: true,
      data: { VI, NE, I, SCOI },
      sources: webData,
    };
  } catch (err) {
    console.error("autoFetchAndScore error:", err);
    return null;
  }
}
