// routes/api_lms.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = Router();

// fallback file path (importer writes here)
const FALLBACK_PATH = "/mnt/data/responsibilityQuiz.txt";

// Try to load Question model lazily (works if you have models/question.js)
let QuestionModel = null;
async function loadQuestionModel() {
  if (QuestionModel) return QuestionModel;
  try {
    const mod = await import("../models/question.js");
    QuestionModel = mod.default || mod;
    return QuestionModel;
  } catch (e) {
    // model not present
    QuestionModel = null;
    return null;
  }
}

/**
 * Parse fallback text into blocks — same format used in your importer.
 */
function parseQuestionBlocks(raw) {
  if (!raw || typeof raw !== "string") return [];
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const parsed = [];
  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    // strip leading number
    if (/^\d+\.\s*/.test(lines[0])) lines[0] = lines[0].replace(/^\d+\.\s*/, "");
    const questionText = lines[0];
    const choiceLines = lines.filter(l => /^[a-d]\)/i.test(l)).slice(0,4);
    const choices = choiceLines.map(cl => cl.replace(/^[a-d]\)\s*/i, "").trim());
    // find correct index if present
    let correctIndex = null;
    const correctLine = lines.find(l => /Correct Answer:/i.test(l) || /✅ Correct Answer:/i.test(l));
    if (correctLine) {
      const m = correctLine.match(/Correct Answer:\s*([a-d])/i);
      if (m) correctIndex = { a:0,b:1,c:2,d:3 }[m[1].toLowerCase()];
      else {
        const txt = correctLine.replace(/Correct Answer:\s*/i,"").trim();
        const found = choices.findIndex(c => c.toLowerCase().startsWith(txt.toLowerCase()) || c.toLowerCase() === txt.toLowerCase());
        if (found>=0) correctIndex = found;
      }
    }
    if (!questionText || choices.length===0) continue;
    parsed.push({ text: questionText, choices: choices.map(t=>({text:t})), correctIndex });
  }
  return parsed;
}

/**
 * GET /api/lms/quiz?count=5
 * Return random `count` questions.
 */
router.get("/quiz", async (req, res) => {
  try {
    const count = Math.max(1, Math.min(20, parseInt(req.query.count || "5", 10)));
    // 1) try DB
    const Question = await loadQuestionModel();
    if (Question) {
      // return random docs (Mongo $sample)
      const agg = await Question.aggregate([{ $sample: { size: count } }]).allowDiskUse(true);
      if (agg && agg.length) {
        const series = agg.map(q => ({
          id: String(q._id),
          text: q.text || q.question || "",
          choices: (q.choices || []).slice(0,4).map(c => ({ text: (typeof c === "string" ? c : (c && c.text) || "" ) })),
          tags: q.tags || []
        }));
        return res.json({ examId: `db-${Date.now()}`, series, total: series.length });
      }
    }

    // 2) fallback file
    if (fs.existsSync(FALLBACK_PATH)) {
      const raw = fs.readFileSync(FALLBACK_PATH, "utf8");
      const parsed = parseQuestionBlocks(raw);
      if (parsed.length) {
        // pick random sample from parsed
        const shuffled = parsed.sort(()=>0.5-Math.random());
        const pick = shuffled.slice(0, count);
        const series = pick.map((p, i) => ({ id: `f-${i}-${Date.now()}`, text: p.text, choices: p.choices, tags: ["fallback"] }));
        return res.json({ examId: `file-${Date.now()}`, series, total: series.length });
      }
    }

    return res.status(404).json({ error: "No quiz questions available. Import questions in Admin or place a file at " + FALLBACK_PATH });
  } catch (err) {
    console.error("[api_lms] /quiz error:", err && (err.stack || err));
    return res.status(500).json({ error: "Server error", detail: String(err.message || err) });
  }
});

/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [ {questionId, choiceIndex} ] }
 * Grades and returns details (correctIndex, yourIndex, correct boolean)
 *
 * NOTE: If question came from fallback file there is no persisted correctIndex
 * unless you inserted into DB. But we attempt to resolve if fallback contains correctIndex
 * by re-reading fallback file and matching text.
 */
router.post("/quiz/submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    if (!answers.length) return res.status(400).json({ error: "No answers provided" });

    // Build lookup for correct answers from DB if possible
    const Question = await loadQuestionModel();
    const details = [];
    let score = 0;

    // If DB model present, fetch docs for ids found
    const dbLookup = {};
    if (Question) {
      const ids = answers.map(a => (a.questionId ? a.questionId : null)).filter(Boolean);
      if (ids.length) {
        // try to find by _id
        const docs = await Question.find({ _id: { $in: ids } }).lean();
        for (const d of docs) {
          dbLookup[String(d._id)] = { correctIndex: typeof d.correctIndex === "number" ? d.correctIndex : null };
        }
      }
    }

    // fallback parse (if fallback file exists) to map by question text
    let fallbackMap = {};
    if (fs.existsSync(FALLBACK_PATH)) {
      const raw = fs.readFileSync(FALLBACK_PATH, "utf8");
      const parsed = parseQuestionBlocks(raw);
      for (const p of parsed) {
        // use trimmed question text as key
        fallbackMap[(p.text || "").trim()] = p;
      }
    }

    for (const ans of answers) {
      const qid = ans.questionId;
      const yourIndex = typeof ans.choiceIndex === "number" ? ans.choiceIndex : null;
      let correctIndex = null;
      // 1) DB lookup
      if (qid && dbLookup[qid] && typeof dbLookup[qid].correctIndex === "number") {
        correctIndex = dbLookup[qid].correctIndex;
      }
      // 2) fallback: try to match by question text if provided in payload (some UIs send question text too)
      if (correctIndex === null && ans.questionText) {
        const key = (ans.questionText || "").trim();
        if (fallbackMap[key] && typeof fallbackMap[key].correctIndex === "number") correctIndex = fallbackMap[key].correctIndex;
      }
      // 3) last resort: try to find by small text match in fallback map keys
      if (correctIndex === null && qid && qid.startsWith("f-")) {
        // attempt to use qid index position - not guaranteed
      }

      const correct = (typeof correctIndex === "number" && yourIndex === correctIndex);
      if (correct) score++;
      details.push({ questionId: qid, yourIndex, correctIndex, correct });
    }

    const total = answers.length;
    const percentage = total ? Math.round((score/total)*100) : 0;
    // default pass threshold 60%
    const passThreshold = parseInt(process.env.QUIZ_PASS_THRESHOLD || "60", 10);
    const passed = percentage >= passThreshold;

    return res.json({ score, total, percentage, passThreshold, passed, details });
  } catch (err) {
    console.error("[api_lms] /quiz/submit error:", err && (err.stack || err));
    return res.status(500).json({ error: "Submit failed", detail: String(err.message || err) });
  }
});

export default router;
