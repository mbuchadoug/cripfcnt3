// routes/api_lms.js
import { Router } from "express";
import fs from "fs";
import path from "path";

const router = Router();

// Path to the uploaded quiz text (you said you uploaded to /mnt/data/)
const QUIZ_FILE = process.env.QUIZ_FILE_PATH || "/mnt/data/responsibilityQuiz.txt";

// In-memory store
let QUESTIONS = []; // array of { id, text, choices: [{text}], correctIndex }
let QUESTION_MAP = {}; // id -> question

/**
 * parseQuizFile(txt)
 * Simple robust parser for the format you provided:
 * - Questions are numbered "1. Question..."
 * - Choices are lines starting "a) ...", "b) ...", etc.
 * - Correct answer lines include "✅ Correct Answer: b)" or similar (we extract first letter a-d)
 */
function parseQuizFile(txt) {
  if (!txt || typeof txt !== "string") return [];
  const lines = txt.split(/\r?\n/);
  const questions = [];
  let cur = null;

  function flushCurrent() {
    if (!cur) return;
    // ensure we have at least 2 choices
    if (cur.choices && cur.choices.length >= 2) {
      questions.push(cur);
    }
    cur = null;
  }

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) {
      // blank line => flush between blocks
      flushCurrent();
      continue;
    }

    // new question line like "1. Taking responsibility..."
    const qMatch = line.match(/^\d+\.\s*(.+)$/);
    if (qMatch) {
      // flush previous
      flushCurrent();
      cur = { text: qMatch[1].trim(), choices: [], correctIndex: null };
      continue;
    }

    // alternative: sometimes the question may not have the numeric prefix (try detect)
    const maybeQ = line.match(/^Q\d+\.\s*(.+)$/i);
    if (!cur && maybeQ) {
      cur = { text: maybeQ[1].trim(), choices: [], correctIndex: null };
      continue;
    }

    // choice line: "a) text" or "a. text" or "a)Text"
    const choiceMatch = line.match(/^[a-d]\s*[)\.]\s*(.+)$/i);
    if (choiceMatch && cur) {
      cur.choices.push(choiceMatch[1].trim());
      continue;
    }

    // detect "✅ Correct Answer: b) Stepping in..." or "✅ Correct Answer: b) "
    const correctMatch = line.match(/✅\s*Correct Answer\s*:\s*([a-d])/i) || line.match(/Correct Answer\s*:\s*([a-d])/i);
    if (correctMatch && cur) {
      const letter = correctMatch[1].toLowerCase();
      cur.correctIndex = letter.charCodeAt(0) - 97;
      continue;
    }

    // Also support lines like "✅ Correct Answer: b) Stepping in where needed..."
    const inlineLetter = (line.match(/✅.*?([a-d])[)\.]/i) || line.match(/Correct Answer.*?([a-d])[)\.]/i));
    if (inlineLetter && cur) {
      const letter = inlineLetter[1].toLowerCase();
      cur.correctIndex = letter.charCodeAt(0) - 97;
      continue;
    }

    // If we reach here and cur exists and none matched, treat the line as continuation of question text (rare)
    if (cur && cur.choices.length === 0) {
      cur.text += " " + line;
      continue;
    }

    // ignore any other stray lines
  }

  // flush final
  flushCurrent();

  // sanitize: remove any question without enough choices
  const clean = questions.map((q, idx) => {
    // ensure correctIndex valid
    let ci = (typeof q.correctIndex === "number" && q.correctIndex >= 0 && q.correctIndex < q.choices.length) ? q.correctIndex : null;
    return { text: q.text, choices: q.choices, correctIndex: ci };
  }).filter(q => q.choices && q.choices.length >= 2);

  return clean;
}

function loadQuestionsFromFile() {
  try {
    if (!fs.existsSync(QUIZ_FILE)) {
      console.warn(`[api_lms] QUIZ file not found: ${QUIZ_FILE}`);
      QUESTIONS = [];
      QUESTION_MAP = {};
      return;
    }
    const raw = fs.readFileSync(QUIZ_FILE, "utf8");
    const parsed = parseQuizFile(raw);
    // assign ids
    QUESTIONS = parsed.map((q, i) => {
      const id = `q_${Date.now()}_${i}_${Math.floor(Math.random()*10000)}`;
      return { id, text: q.text, choices: q.choices.map(c => ({ text: c })), correctIndex: q.correctIndex };
    });

    QUESTION_MAP = {};
    for (const q of QUESTIONS) QUESTION_MAP[q.id] = q;

    console.log(`[api_lms] Loaded ${QUESTIONS.length} questions from ${QUIZ_FILE}`);
  } catch (err) {
    console.error("[api_lms] failed to load quiz file:", err && (err.stack || err));
    QUESTIONS = [];
    QUESTION_MAP = {};
  }
}

// Load at startup
loadQuestionsFromFile();

/**
 * GET /api/lms/quiz?count=5
 * Returns: { examId, series: [ { id, text, choices:[{text}] } ] }
 */
router.get("/quiz", (req, res) => {
  const count = Math.min(50, Math.max(1, parseInt(String(req.query.count || "5"), 10)));
  if (!QUESTIONS || QUESTIONS.length === 0) {
    return res.status(404).json({ error: "No quiz questions available. Import questions in Admin or place a file at " + QUIZ_FILE });
  }

  // pick random unique questions
  const shuffled = QUESTIONS.slice().sort(() => 0.5 - Math.random());
  const pick = shuffled.slice(0, Math.min(count, shuffled.length));

  // series: exclude correctIndex from response (UI should not receive correctIndex)
  const series = pick.map(q => ({
    id: q.id,
    text: q.text,
    choices: q.choices.map(c => ({ text: c.text }))
  }));

  const examId = `exam_${Date.now()}_${Math.floor(Math.random()*100000)}`;

  // We don't persist exam server-side here (stateless), instead rely on question ids being valid and present in QUESTION_MAP at submission.
  return res.json({ examId, series });
});


/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [ { questionId, choiceIndex } ] }
 *
 * Returns:
 * {
 *   score, total, percentage, passThreshold, passed, details: [{ questionId, correctIndex, yourIndex }]
 * }
 */
router.post("/quiz/submit", (req, res) => {
  try {
    const payload = req.body || {};
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    const passThreshold = Number(process.env.QUIZ_PASS_PERCENT || 60);

    if (!answers.length) {
      return res.status(400).json({ error: "No answers provided" });
    }

    let correctCount = 0;
    const details = [];

    for (const a of answers) {
      const qid = a.questionId;
      const yourIndex = (typeof a.choiceIndex === "number") ? a.choiceIndex : null;
      const q = QUESTION_MAP[qid];
      if (!q) {
        // Mark as unanswered/invalid
        details.push({ questionId: qid, correctIndex: null, yourIndex });
        continue;
      }
      const correctIndex = (typeof q.correctIndex === "number") ? q.correctIndex : null;
      const isCorrect = (correctIndex !== null && yourIndex === correctIndex);
      if (isCorrect) correctCount++;
      details.push({ questionId: qid, correctIndex, yourIndex });
    }

    const total = answers.length;
    const score = correctCount;
    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passed = percentage >= passThreshold;

    return res.json({
      score,
      total,
      percentage,
      passThreshold,
      passed,
      details
    });
  } catch (err) {
    console.error("[api_lms] submit error:", err && (err.stack || err));
    return res.status(500).json({ error: "submission failed" });
  }
});

export default router;
