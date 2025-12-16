// routes/admin/lms_import.js
import { Router } from "express";
import multer from "multer";
import ensureAuth from "../../middleware/authGuard.js"; // your ensureAuth export style is named; adjust if needed
import QuizQuestion from "../../models/quizQuestion.js";
import { getAdminSet } from "../admin.js"; // reuse if available - fallback below

const router = Router();

// multer memory storage (we only need the buffer)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 5 } }); // 5MB

// small helper ensureAdmin (in case admin.js helper isn't importable)
// If you already have ensureAdmin exported from routes/admin.js you can import that instead.
function ensureAdmin(req, res, next) {
  try {
    const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
    const ADMIN_SET = new Set(
      (process.env.ADMIN_EMAILS || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    if (!email || !ADMIN_SET.has(email)) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(403).send("<h3>Forbidden — admin only</h3>");
      }
      return res.status(403).json({ error: "Forbidden — admin only" });
    }
    return next();
  } catch (e) {
    return next(e);
  }
}

// GET upload form
router.get("/import", (req, res) => {
  // require auth & admin
  if (!(req.isAuthenticated && req.isAuthenticated && req.isAuthenticated())) {
    return res.redirect("/auth/google");
  }
  // check admin
  const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
  const ADMIN_SET = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!email || !ADMIN_SET.has(email)) {
    return res.status(403).send("Forbidden — admin only");
  }

  return res.render("admin/lms_import", { title: "Import LMS Questions", user: req.user });
});

/**
 * POST /admin/lms/import
 * Accepts form-data 'file' (text/plain) or a JSON body 'text' to parse directly.
 */
router.post("/import", upload.single("file"), async (req, res) => {
  try {
    // require auth & admin
    if (!(req.isAuthenticated && req.isAuthenticated && req.isAuthenticated())) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
    const ADMIN_SET = new Set(
      (process.env.ADMIN_EMAILS || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    if (!email || !ADMIN_SET.has(email)) {
      return res.status(403).json({ error: "Forbidden — admin only" });
    }

    let rawText = "";

    if (req.file && req.file.buffer) {
      rawText = req.file.buffer.toString("utf8");
    } else if (req.body && req.body.text) {
      rawText = String(req.body.text);
    } else {
      return res.status(400).json({ error: "No file or text provided" });
    }

    // Run parser
    const { parsed, errors } = parseQuestionsFromText(rawText);

    if (!parsed.length) {
      return res.render("admin/lms_import", { title: "Import Results", result: { inserted: 0, parsed: 0, errors }, user: req.user });
    }

    // Insert into DB but mark source 'import'
    const toInsert = parsed.map(p => ({ ...p, source: "import", createdAt: new Date() }));
    const inserted = await QuizQuestion.insertMany(toInsert, { ordered: true });

    const summary = {
      parsed: parsed.length,
      inserted: inserted.length,
      errors
    };

    return res.render("admin/lms_import", { title: "Import Results", result: summary, user: req.user });
  } catch (err) {
    console.error("Import failed:", err);
    return res.status(500).send("Import failed: " + (err.message || String(err)));
  }
});

export default router;

/**
 * Parser: Accepts raw text and returns { parsed: [ { text, choices, answerIndex, tags, difficulty, instructions } ], errors: [...] }
 *
 * Expected block format (per question):
 *
 * 1. Question text...
 * a) Choice A
 * b) Choice B
 * c) Choice C
 * d) Choice D
 * ✅ Correct Answer: b) Stepping in where needed, even beyond your direct role.
 *
 * Optional file-level 'Instructions:' or question-level 'Instructions:' lines are supported.
 */
function parseQuestionsFromText(raw) {
  const errors = [];
  const parsed = [];

  if (!raw || typeof raw !== "string") return { parsed, errors };

  // Normalize line endings:
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Optional: If file contains a top-level "Instructions:" section, capture it
  let globalInstructions = "";
  const instrMatch = text.match(/(?:^|\n)Instructions:\s*([\s\S]*?)(?=\n\s*\n|$)/i);
  if (instrMatch) {
    globalInstructions = instrMatch[1].trim();
  }

  // Split into blocks separated by two or more newlines
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);

  // Helper to extract a choice label -> index
  const choiceLetterToIndex = (letter) => {
    if (!letter) return -1;
    const m = letter.trim().toLowerCase().match(/^([a-d])/);
    if (!m) return -1;
    return "abcd".indexOf(m[1]);
  };

  for (const block of blocks) {
    try {
      // skip pure "Instructions" block if it was captured already
      if (/^Instructions?:/i.test(block)) continue;

      // Try to find the question line (start with optional number and dot)
      // e.g. "1. Taking responsibility in a team means:"
      const qMatch = block.match(/^\s*(?:\d+\s*[\.\)]\s*)?(.+?)(?=\n|$)/);
      if (!qMatch) {
        errors.push({ block: block.slice(0, 120), reason: "No question line found" });
        continue;
      }
      let qText = qMatch[1].trim();

      // Now extract choices a) b) c) d)
      // Find all lines beginning with a) or a. or a)
      const choiceRegex = /^[ \t]*([a-dA-D])[\.\)]\s*(.+)$/gm;
      const choices = [];
      let m;
      while ((m = choiceRegex.exec(block)) !== null) {
        choices.push(m[2].trim());
      }

      if (choices.length < 2) {
        // maybe choices are inline separated by newlines but without labels; attempt other patterns
        // Look for lines that look like "a) ..." etc case-insensitive already handled
        errors.push({ question: qText, reason: `Expected labelled choices a)-d). Found ${choices.length}.` });
        continue;
      }

      // find answer line: "✅ Correct Answer:" or "Correct Answer:" or "Answer:"
      let answerIndex = -1;
      let ansMatch = block.match(/✅\s*Correct Answer\s*:\s*(.+)$/im) || block.match(/Correct Answer\s*:\s*(.+)$/im) || block.match(/Answer\s*:\s*(.+)$/im);
      if (ansMatch) {
        const ansText = ansMatch[1].trim();
        // If answer text begins with letter like "b)" or "b." or "b)"
        const letterMatch = ansText.match(/^([a-dA-D])[\.\)]?/);
        if (letterMatch) {
          answerIndex = choiceLetterToIndex(letterMatch[1]);
        } else {
          // try to match by choice text content (find nearest match in choices)
          const found = choices.findIndex(c => {
            // compare normalized
            return normalizeForCompare(c) === normalizeForCompare(ansText) || c.toLowerCase().startsWith(ansText.toLowerCase()) || ansText.toLowerCase().startsWith(c.toLowerCase());
          });
          if (found >= 0) answerIndex = found;
          else {
            // maybe ansText contains a letter inside parentheses
            const insideLetter = ansText.match(/\(([a-dA-D])\)/);
            if (insideLetter) answerIndex = choiceLetterToIndex(insideLetter[1]);
          }
        }
      } else {
        // No explicit answer found — attempt to find a trailing line like "✅ Correct Answer: c) text"
        // If still not found, skip as parse error
      }

      if (answerIndex < 0 || answerIndex >= choices.length) {
        errors.push({ question: qText, reason: `Could not determine correct answer from block. Choices found: ${choices.length}` });
        continue;
      }

      // optional difficulty/tags: not required, try to detect "[easy]" or "difficulty: easy" or "tags: x,y"
      let difficulty = "medium";
      const diffMatch = block.match(/difficulty\s*[:\-]\s*(easy|medium|hard)/i) || block.match(/\[(easy|medium|hard)\]/i);
      if (diffMatch) difficulty = diffMatch[1].toLowerCase();

      const tags = [];
      const tagMatch = block.match(/tags?\s*[:\-]\s*([a-zA-Z0-9,\s\-]+)/i);
      if (tagMatch) {
        tagMatch[1].split(",").map(t => t.trim()).filter(Boolean).forEach(t => tags.push(t));
      }

      // optional per-question instructions
      let instructions = "";
      const instrQ = block.match(/Instructions?:\s*([\s\S]+?)$/i);
      if (instrQ) instructions = instrQ[1].trim();

      // final build
      parsed.push({
        text: qText,
        choices,
        answerIndex,
        tags,
        difficulty,
        instructions: instructions || globalInstructions || ""
      });

    } catch (e) {
      errors.push({ block: block.slice(0, 120), reason: e.message || String(e) });
    }
  } // end for blocks

  return { parsed, errors };
}

function normalizeForCompare(s) {
  return String(s || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}
