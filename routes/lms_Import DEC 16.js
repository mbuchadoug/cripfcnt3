// routes/admin/lms_import.js
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import ensureAuth from "../../middleware/authGuard.js";
import Question from "../../models/question.js";
import Organization from "../../models/organization.js";

const router = Router();

// multer memory storage - we use upload.any() in-route to avoid Unexpected field
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 12 } });

/* Basic ensureAdmin - adjust if you have your own implementation */
function ensureAdmin(req, res, next) {
  try {
    const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
    const ADMIN_SET = new Set(
      (process.env.ADMIN_EMAILS || "")
        .split(",")
        .map(s => s.trim().toLowerCase())
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

/* GET form */
router.get("/import", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
    return res.render("admin/lms_import", { title: "Import LMS Questions", user: req.user, organizations });
  } catch (err) {
    console.error("[GET /admin/lms/import] error:", err && (err.stack || err));
    return res.status(500).send("failed to render import page");
  }
});

/**
 * POST /admin/lms/import
 * - accepts files (any fieldnames) or textarea 'text'
 * - tries comprehension parsing first; if found, creates child Question docs then a parent doc with type:'comprehension'
 * - fallback to single-question parsing
 * - respects textarea + file pairing: if you upload passageFile + file it will combine them
 * - logs detailed info to server console for debugging
 */
router.post("/import", ensureAuth, ensureAdmin, (req, res) => {
  // call multer.any() explicitly so we can catch Multer errors here
  upload.any()(req, res, async (multerErr) => {
    console.log("========== [IMPORT] START ==========");
    try {
      if (multerErr) {
        console.error("[MULTER ERROR]", multerErr && (multerErr.stack || multerErr));
        const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
        return res.render("admin/lms_import", {
          title: "Import Results",
          result: { parsed: 0, inserted: 0, errors: [{ reason: `Multer error: ${multerErr.message}` }] },
          user: req.user,
          organizations
        });
      }

      console.log("[IMPORT] files count:", Array.isArray(req.files) ? req.files.length : 0);
      (Array.isArray(req.files) ? req.files : []).forEach((f, i) => {
        console.log(`[IMPORT] file[${i}] field=${f.fieldname} name=${f.originalname} mime=${f.mimetype} size=${f.size}`);
        try {
          const preview = f.buffer ? f.buffer.toString("utf8").replace(/\s+/g, " ").slice(0, 200) : "";
          if (preview) console.log(`[IMPORT] preview[${i}]: "${preview}"`);
        } catch (e) { /* ignore preview errors */ }
      });

      console.log("[IMPORT] body keys:", Object.keys(req.body || {}));
      if (req.body && typeof req.body.text === "string") {
        console.log("[IMPORT] body.text preview:", String(req.body.text).replace(/\s+/g, " ").slice(0, 200));
      }

      // collect text sources (filename + text)
      const texts = [];

      // pairing: if passageFile uploaded and questions file(s) uploaded, combine them
      const filesArr = Array.isArray(req.files) ? req.files : [];
      const passageFile = filesArr.find(f => f.fieldname === "passageFile");
      const questionFiles = filesArr.filter(f => ["file", "files", "questions", "qfile"].includes(f.fieldname));

      if (passageFile && questionFiles.length) {
        const passageText = passageFile.buffer ? passageFile.buffer.toString("utf8") : "";
        for (const qf of questionFiles) {
          const qtext = qf.buffer ? qf.buffer.toString("utf8") : "";
          if (!qtext.trim()) continue;
          texts.push({ filename: `${passageFile.originalname}+${qf.originalname}`, text: passageText + "\n\n---\n\n" + qtext });
        }
      }

      // add any standalone uploaded files not used in pair
      for (const f of filesArr) {
        const usedInPair = passageFile && (f === passageFile || questionFiles.includes(f));
        if (usedInPair) continue;
        const txt = f.buffer ? f.buffer.toString("utf8") : "";
        if (!txt.trim()) { console.log(`[IMPORT] skipping empty file ${f.originalname}`); continue; }
        texts.push({ filename: f.originalname || f.fieldname, text: txt });
      }

      // fallback to pasted textarea
      if (!texts.length && req.body && req.body.text && String(req.body.text).trim()) {
        texts.push({ filename: "pasted", text: String(req.body.text) });
      }

      if (!texts.length) {
        const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
        return res.render("admin/lms_import", {
          title: "Import Results",
          result: { parsed: 0, inserted: 0, errors: [{ reason: "No file(s) or text provided" }] },
          user: req.user,
          organizations
        });
      }

      console.log(`[IMPORT] processing ${texts.length} text source(s): ${texts.map(t => t.filename).join(", ")}`);

      // check save checkbox - only save if user checked 'save'
      const shouldSave = !!req.body.save || req.body.save === "1" || req.body.save === "on";
      console.log("[IMPORT] shouldSave:", shouldSave);

      // optional org/module
      const orgId = req.body.orgId && mongoose.isValidObjectId(req.body.orgId) ? mongoose.Types.ObjectId(req.body.orgId) : null;
      const moduleName = String(req.body.module || "general").trim().toLowerCase();
      console.log("[IMPORT] orgId:", String(orgId), "module:", moduleName);

      // counters and logging
      let parsedItems = 0;
      let insertedParents = 0;
      let insertedChildren = 0;
      const allErrors = [];
      const preview = [];

      // helper: normalize weird dashes to hyphen sequences is done inside parser

      for (const item of texts) {
        console.log(`--- [IMPORT] file: ${item.filename} length=${String(item.text).length} ---`);
        const raw = item.text || "";
        if (!raw.trim()) {
          allErrors.push({ file: item.filename, reason: "Empty content" });
          continue;
        }

        // try comprehension parse first
        const { parsedComprehensions, errors: compErrors } = parseComprehensionFromText(raw);
        if (compErrors && compErrors.length) {
          compErrors.forEach(e => {
            allErrors.push({ file: item.filename, ...e });
            console.log("[IMPORT] comprehension parse error:", e);
          });
        }

        if (parsedComprehensions && parsedComprehensions.length) {
          console.log(`[IMPORT] parsed ${parsedComprehensions.length} comprehension(s) from ${item.filename}`);
          for (const comp of parsedComprehensions) {
            parsedItems++;
            preview.push((comp.passage || "").slice(0, 400));
            if (!shouldSave) {
              console.log("[IMPORT] preview only (not saving) for comprehension in", item.filename);
              continue;
            }

            // build child docs
            const childDocs = (comp.questions || []).map(q => ({
              text: q.text,
              choices: (q.choices || []).map(c => ({ text: c })),
              correctIndex: typeof q.answerIndex === "number" ? q.answerIndex : 0,
              tags: q.tags || [],
              difficulty: q.difficulty || "medium",
              source: "import",
              organization: orgId,
              module: moduleName,
              raw: '',
              createdAt: new Date()
            }));

            try {
              const inserted = await Question.insertMany(childDocs, { ordered: true });
              const childIds = inserted.map(d => d._id);
              console.log("[IMPORT] inserted children IDs:", childIds);

              // create parent doc with type: 'comprehension'
              const parentDoc = {
                text: (comp.passage || "").split("\n").slice(0, 1).join(" ").slice(0, 120) || "Comprehension passage",
                type: "comprehension",
                passage: comp.passage,
                questionIds: childIds,
                tags: comp.tags || [],
                source: "import",
                organization: orgId,
                module: moduleName,
                createdAt: new Date()
              };

              const parent = await Question.create(parentDoc);
              console.log("[IMPORT] inserted parent ID:", parent._id);

              // tag children with a parent tag for easier querying if desired
              await Question.updateMany({ _id: { $in: childIds } }, { $addToSet: { tags: `comprehension-${parent._id}` } }).exec();

              insertedParents++;
              insertedChildren += childIds.length;
            } catch (e) {
              console.error("[IMPORT] DB insert for comprehension failed:", e && (e.stack || e));
              allErrors.push({ file: item.filename, reason: "DB insert failed for comprehension", error: String(e && e.message) });
            }
          } // end each comprehension
          continue; // next text source
        } // end if comprehension found

        // fallback: single-question parser
        const { parsed, errors } = parseQuestionsFromText(raw);
        if (errors && errors.length) {
          errors.forEach(e => {
            allErrors.push({ file: item.filename, ...e });
            console.log("[IMPORT] single parse error:", e);
          });
        }

        if (!parsed || !parsed.length) {
          console.log(`[IMPORT] no questions parsed from ${item.filename}`);
          allErrors.push({ file: item.filename, reason: "No valid questions parsed" });
          continue;
        }

        parsedItems += parsed.length;
        preview.push(parsed.slice(0, 3).map(q => q.text).join("\n---\n"));

        if (!shouldSave) {
          console.log("[IMPORT] preview only (not saving) for single-question file", item.filename);
          continue;
        }

        const toInsert = parsed.map(p => ({
          text: p.text,
          choices: (p.choices || []).map(c => ({ text: c })),
          correctIndex: typeof p.answerIndex === "number" ? p.answerIndex : 0,
          tags: p.tags || [],
          difficulty: p.difficulty || "medium",
          instructions: p.instructions || "",
          source: "import",
          organization: orgId,
          module: moduleName,
          raw: '',
          createdAt: new Date()
        }));

        try {
          const inserted = await Question.insertMany(toInsert, { ordered: true });
          console.log("[IMPORT] inserted single-question IDs (first up to 5):", inserted.slice(0,5).map(x => x._id));
          insertedChildren += inserted.length;
        } catch (e) {
          console.error("[IMPORT] insert single questions failed:", e && (e.stack || e));
          allErrors.push({ file: item.filename, reason: "DB insert failed for single questions", error: String(e && e.message) });
        }
      } // end for texts

      const summary = {
        parsedFiles: texts.length,
        parsedItems,
        insertedParents,
        insertedChildren,
        errors: allErrors
      };

      console.log("========== [IMPORT] SUMMARY ==========");
      console.log(JSON.stringify(summary, null, 2));
      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      return res.render("admin/lms_import", { title: "Import Results", result: summary, preview: preview.slice(0,5), user: req.user, organizations });

    } catch (err) {
      console.error("[IMPORT] unexpected error:", err && (err.stack || err));
      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      return res.render("admin/lms_import", {
        title: "Import Results",
        result: { parsed: 0, inserted: 0, errors: [{ reason: "Unexpected server error", error: String(err && err.message) }] },
        user: req.user,
        organizations
      });
    } finally {
      console.log("=========== [IMPORT] END ===========");
    }
  });
});

/* -------------------- Parsers -------------------- */

function parseComprehensionFromText(raw) {
  const errors = [];
  const parsedComprehensions = [];
  if (!raw || typeof raw !== "string") return { parsedComprehensions, errors };

  // normalize line endings and replace fancy dashes with hyphens
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u2013\u2014\u2015\u2212]+/g, '-');

  // find delimiter line with 3+ hyphens on its own line
  const delimRegex = /^[ \t]*-{3,}[ \t]*$/m;
  const delimMatch = normalized.match(delimRegex);
  if (!delimMatch) return { parsedComprehensions: [], errors };

  const idx = normalized.search(delimRegex);
  const passage = normalized.slice(0, idx).trim();
  const after = normalized.slice(idx).replace(delimRegex, '').trim();
  if (!passage || !after) {
    errors.push({ reason: "Passage or question block missing around delimiter" });
    return { parsedComprehensions: [], errors };
  }

  const qBlocks = after.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);

  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const letterToIndex = (letter) => {
    if (!letter) return -1;
    const m = letter.trim().toLowerCase().match(/^([a-z])/);
    if (!m) return -1;
    return alphabet.indexOf(m[1]);
  };

  const questions = [];
  for (const block of qBlocks) {
    try {
      const qMatch = block.match(/^\s*(?:\d+\s*[\.\)]\s*)?(.+?)(?=\n|$)/);
      if (!qMatch) { errors.push({ block: block.slice(0,120), reason: "No question line found" }); continue; }
      const qText = qMatch[1].trim();

      const choiceRegex = /^[ \t]*([a-zA-Z])[\.\)]\s*(.+)$/gm;
      const choices = [];
      let m;
      while ((m = choiceRegex.exec(block)) !== null) choices.push(m[2].trim());

      if (choices.length < 2) { errors.push({ question: qText, reason: `Expected labeled choices. Found ${choices.length}.` }); continue; }

      let answerIndex = -1;
      const ansMatch =
        block.match(/✅\s*Correct Answer\s*[:\-]?\s*(.+)$/im) ||
        block.match(/Correct Answer\s*[:\-]?\s*(.+)$/im) ||
        block.match(/Answer\s*[:\-]?\s*(.+)$/im);

      if (ansMatch) {
        const ansText = ansMatch[1].trim();
        const lm = ansText.match(/^([a-zA-Z])[\.\)]?/);
        if (lm) answerIndex = letterToIndex(lm[1]);
        else {
          const normalize = s => String(s||'').replace(/[^a-z0-9]+/gi,' ').trim().toLowerCase();
          const found = choices.findIndex(c => normalize(c) === normalize(ansText) || c.toLowerCase().startsWith(ansText.toLowerCase()) || ansText.toLowerCase().startsWith(c.toLowerCase()));
          if (found >= 0) answerIndex = found;
        }
      }

      if (answerIndex < 0 || answerIndex >= choices.length) { errors.push({ question: qText, reason: "Could not determine correct answer" }); continue; }

      questions.push({ text: qText, choices, answerIndex, tags: [], difficulty: "medium", instructions: "" });
    } catch (e) {
      errors.push({ block: block.slice(0,120), reason: String(e && e.message) });
    }
  }

  if (questions.length) parsedComprehensions.push({ passage, questions });
  else errors.push({ reason: "No valid sub-questions parsed from quiz block." });

  return { parsedComprehensions, errors };
}

function parseQuestionsFromText(raw) {
  const errors = [];
  const parsed = [];
  if (!raw || typeof raw !== "string") return { parsed, errors };

  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let globalInstructions = "";
  const instrMatch = text.match(/(?:^|\n)Instructions:\s*([\s\S]*?)(?=\n\s*\n|$)/i);
  if (instrMatch) globalInstructions = instrMatch[1].trim();

  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const choiceLetterToIndex = (letter) => {
    if (!letter) return -1;
    const m = letter.trim().toLowerCase().match(/^([a-d])/);
    if (!m) return -1;
    return "abcd".indexOf(m[1]);
  };

  for (const block of blocks) {
    try {
      if (/^Instructions?:/i.test(block)) continue;
      const qMatch = block.match(/^\s*(?:\d+\s*[\.\)]\s*)?(.+?)(?=\n|$)/);
      if (!qMatch) { errors.push({ block: block.slice(0,120), reason: "No question line found" }); continue; }
      const qText = qMatch[1].trim();

      const choiceRegex = /^[ \t]*([a-dA-D])[\.\)]\s*(.+)$/gm;
      const choices = [];
      let m;
      while ((m = choiceRegex.exec(block)) !== null) choices.push(m[2].trim());

      if (choices.length < 2) { errors.push({ question: qText, reason: `Expected labelled choices a)-d). Found ${choices.length}.` }); continue; }

      let answerIndex = -1;
      const ansMatch =
        block.match(/✅\s*Correct Answer\s*[:\-]?\s*(.+)$/im) ||
        block.match(/Correct Answer\s*[:\-]?\s*(.+)$/im) ||
        block.match(/Answer\s*[:\-]?\s*(.+)$/im);

      if (ansMatch) {
        const ansText = ansMatch[1].trim();
        const letterMatch = ansText.match(/^([a-dA-D])[\.\)]?/);
        if (letterMatch) answerIndex = choiceLetterToIndex(letterMatch[1]);
        else {
          const found = choices.findIndex(c => normalizeForCompare(c) === normalizeForCompare(ansText) || c.toLowerCase().startsWith(ansText.toLowerCase()) || ansText.toLowerCase().startsWith(c.toLowerCase()));
          if (found >= 0) answerIndex = found;
          else {
            const insideLetter = ansText.match(/\(([a-dA-D])\)/);
            if (insideLetter) answerIndex = choiceLetterToIndex(insideLetter[1]);
          }
        }
      }

      if (answerIndex < 0 || answerIndex >= choices.length) { errors.push({ question: qText, reason: `Could not determine correct answer from block. Choices found: ${choices.length}` }); continue; }

      let difficulty = "medium";
      const diffMatch = block.match(/difficulty\s*[:\-]\s*(easy|medium|hard)/i) || block.match(/\[(easy|medium|hard)\]/i);
      if (diffMatch) difficulty = diffMatch[1].toLowerCase();

      const tags = [];
      const tagMatch = block.match(/tags?\s*[:\-]\s*([a-zA-Z0-9,\s\-]+)/i);
      if (tagMatch) tagMatch[1].split(",").map(t => t.trim()).filter(Boolean).forEach(t => tags.push(t));

      let instructions = "";
      const instrQ = block.match(/Instructions?:\s*([\s\S]+?)$/i);
      if (instrQ) instructions = instrQ[1].trim();

      parsed.push({ text: qText, choices, answerIndex, tags, difficulty, instructions: instructions || globalInstructions || "" });
    } catch (e) {
      errors.push({ block: block.slice(0,120), reason: String(e && e.message) });
    }
  }

  return { parsed, errors };
}

function normalizeForCompare(s) {
  return String(s || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

export default router;
