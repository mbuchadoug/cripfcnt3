// routes/admin.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import User from "../models/user.js";
import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";
import Organization from "../models/organization.js";
import { ensureAuth } from "../middleware/authGuard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();
console.log("🔥 admin routes loaded");

// storage for multer (store in memory then write to disk)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// helper: admin set
function getAdminSet() {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function ensureAdmin(req, res, next) {
  const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
  const ADMIN_SET = getAdminSet();
  if (!email || !ADMIN_SET.has(email)) {
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(403).send("<h3>Forbidden — admin only</h3>");
    }
    return res.status(403).json({ error: "Forbidden — admin only" });
  }
  next();
}

// safeRender helper so res.render errors are captured
function safeRender(req, res, view, locals = {}) {
  try {
    return res.render(view, locals, (err, html) => {
      if (err) {
        console.error(`[safeRender] render error for view="${view}":`, err && (err.stack || err));
        if (req.headers.accept && req.headers.accept.includes("text/html")) {
          if (!res.headersSent) {
            return res.status(500).send(`<h3>Server error rendering ${view}</h3><pre>${String(err.message || err)}</pre>`);
          }
          return;
        }
        if (!res.headersSent) return res.status(500).json({ error: "Render failed", detail: String(err.message || err) });
        return;
      }
      if (!res.headersSent) return res.send(html);
    });
  } catch (e) {
    console.error(`[safeRender] synchronous render exception for view="${view}":`, e && (e.stack || e));
    if (!res.headersSent) {
      return res.status(500).send("Server render exception");
    }
  }
}

/**
 * Robust parser for the quiz text format.
 *
 * Accepts blocks separated by one or more blank lines. Each block typically follows:
 *   1. Question text...
 *   a) choice text
 *   b) choice text
 *   c) ...
 *   Correct Answer: b
 *
 * Returns array of { text, choices: [{ text }], correctIndex, rawBlock }
 */
function parseQuestionBlocks(raw) {
  if (!raw || typeof raw !== "string") return [];
  // normalize line endings and trim overall whitespace
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // split into blocks on two or more newlines
  const blocks = normalized.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const parsed = [];

  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.replace(/\t/g, ' ').trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const isChoiceLine = (s) => /^[a-d][\.\)]\s+/i.test(s) || /^\([a-d]\)\s+/i.test(s) || /^[A-D]\)\s+/i.test(s);
    const isCorrectLine = (s) => /Correct Answer:/i.test(s) || /✅\s*Correct Answer:/i.test(s);

    // find index of first choice-line
    let firstChoiceIdx = lines.findIndex(isChoiceLine);
    if (firstChoiceIdx === -1) {
      firstChoiceIdx = lines.findIndex(l => /^[a-d]\s+/.test(l) || /^[A-D]\)\s+/.test(l));
    }

    let questionLines = [];
    let choiceLines = [];
    let footerLines = [];

    if (firstChoiceIdx > 0) {
      questionLines = lines.slice(0, firstChoiceIdx);
      let i = firstChoiceIdx;
      for (; i < lines.length; i++) {
        const line = lines[i];
        if (isCorrectLine(line)) {
          footerLines.push(line);
          i++;
          break;
        }
        if (isChoiceLine(line) || /^[a-d]\s+/.test(line) || /^[A-D]\)\s+/.test(line)) {
          choiceLines.push(line);
        } else {
          if (choiceLines.length) {
            choiceLines[choiceLines.length - 1] += " " + line;
          } else {
            questionLines.push(line);
          }
        }
      }
      // any remaining lines after the loop consider as footer
      for (let j = i; j < lines.length; j++) {
        footerLines.push(lines[j]);
      }
    } else {
      // fallback: first line is question, rest are choices/footers
      questionLines = [lines[0]];
      for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        if (isChoiceLine(l) || /^[a-d]\s+/.test(l) || /^[A-D]\)\s+/.test(l)) {
          choiceLines.push(l);
        } else if (isCorrectLine(l)) {
          footerLines.push(l);
        } else {
          if (choiceLines.length === 0) questionLines.push(l);
          else choiceLines[choiceLines.length - 1] += " " + l;
        }
      }
    }

    // Build question text and strip leading numbering "1. " etc
    let questionText = questionLines.join(" ").trim();
    questionText = questionText.replace(/^\d+\.\s*/, "").trim();

    // normalize choices
    const choices = choiceLines.map(cl => {
      const txt = cl.replace(/^[\(\[]?[a-d][\)\.\]]?\s*/i, "").trim();
      return { text: txt };
    });

    // find correctIndex
    let correctIndex = null;
    const footer = footerLines.join(" ").trim();
    if (footer) {
      const m = footer.match(/Correct Answer:\s*[:\-]?\s*([a-d])\b/i);
      if (m) correctIndex = { a:0,b:1,c:2,d:3 }[m[1].toLowerCase()];
      else {
        const m2 = footer.match(/([a-d])\)/i);
        if (m2) correctIndex = { a:0,b:1,c:2,d:3 }[m2[1].toLowerCase()];
        else {
          const stripped = footer.replace(/Correct Answer:/i, "").replace(/✅/g, "").trim();
          const found = choices.findIndex(c => {
            const lc = (c.text||"").toLowerCase();
            const sc = stripped.toLowerCase();
            return lc.startsWith(sc) || lc === sc || sc.startsWith(lc);
          });
          if (found >= 0) correctIndex = found;
        }
      }
    }

    // If questionText empty, try a fallback: take first non-choice line from block
    if (!questionText) {
      const possible = block.split("\n").map(s => s.trim()).filter(Boolean);
      // pick the first line that isn't a choice line
      const fallback = possible.find(l => !isChoiceLine(l) && !isCorrectLine(l));
      if (fallback) {
        questionText = fallback.replace(/^\d+\.\s*/, "").replace(/^[\(\[]?[a-d][\)\.\]]?\s*/i, "").trim();
      }
    }

    if (!questionText) continue;
    if (choices.length === 0) continue;

    parsed.push({
      text: questionText,
      choices,
      correctIndex: typeof correctIndex === "number" ? correctIndex : null,
      rawBlock: block
    });
  }

  return parsed;
}

// path to save fallback file so API can read it
const FALLBACK_PATH = "/mnt/data/responsibilityQuiz.txt";

// GET import page (render a simple importer)
router.get("/lms/import", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const organizations = await Organization.find().select("_id name slug").sort({ name: 1 }).lean();
    return safeRender(req, res, "admin/lms_import", { title: "Import LMS Questions (paste)", organizations });
  } catch (err) {
    console.error("[admin/lms/import GET] failed to load organizations:", err && (err.stack || err));
    return safeRender(req, res, "admin/lms_import", { title: "Import LMS Questions (paste)", organizations: [] });
  }
});

/**
 * POST /admin/lms/import
 * Accepts:
 *   - file upload (field 'file')
 *   - or pasted text in textarea (field 'text')
 * If 'save' param present (save=1), attempt to save parsed questions to DB (Questions collection).
 */
// REPLACE the existing router.post("/lms/import", ...) handler with the following:

router.post("/lms/import", ensureAuth, ensureAdmin, upload.single("file"), async (req, res) => {
  try {
    // prefer uploaded file -> fallback to textarea 'text'
    let content = "";

    if (req.file && req.file.buffer && req.file.buffer.length) {
      content = req.file.buffer.toString("utf8");
      console.log("[admin/lms/import] received uploaded file:", req.file.originalname, "size:", req.file.size);
    } else if (req.body && typeof req.body.text === "string" && req.body.text.trim().length) {
      content = req.body.text;
      console.log("[admin/lms/import] received pasted text (body.text)");
    } else {
      console.log("[admin/lms/import] no content provided");
    }

    if (!content || !content.trim()) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(400).send("Import failed: No text provided. Paste your questions or upload a .txt file and click Import.");
      }
      return res.status(400).json({ error: "No text provided" });
    }

    // Save fallback file to disk so API /mnt/data reads it (best-effort)
    try {
      const dir = path.dirname(FALLBACK_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(FALLBACK_PATH, content, { encoding: "utf8" });
      console.log(`[admin/lms/import] saved fallback quiz file to ${FALLBACK_PATH}`);
    } catch (err) {
      console.error("[admin/lms/import] failed to write fallback file:", err && (err.stack || err));
    }

    // Detect comprehension delimiter: a line containing 3+ hyphens on its own
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const delimRegex = /^\s*-{3,}\s*$/m;
    const isComprehension = !!normalized.match(delimRegex);

    // read orgId + module from the form
    let orgId = null;
    if (req.body && req.body.orgId && String(req.body.orgId).trim()) {
      try {
        orgId = mongoose.Types.ObjectId(String(req.body.orgId).trim());
      } catch (e) {
        orgId = null;
      }
    }
    const moduleName = (req.body && req.body.module) ? String(req.body.module).trim().toLowerCase() : "general";

    // should we save to DB?
    const saveToDb = req.body && (req.body.save === "1" || req.body.save === "true" || req.body.save === "on");
    console.log("[admin/lms/import] saveToDb=", saveToDb, "module=", moduleName, "orgId=", String(orgId));

    // dynamic import of Question model
    let QuestionModel = null;
    try {
      QuestionModel = (await import("../models/question.js")).default;
    } catch (e) {
      console.warn("[admin/lms/import] could not import Question model:", e && e.message);
      QuestionModel = null;
    }

    let parsedCount = 0;
    let insertedParents = 0;
    let insertedChildren = 0;
    const allErrors = [];
    const previewBlocks = []; // will be array of { rawBlock: "..." }

    if (isComprehension) {
      console.log("[admin/lms/import] detected comprehension delimiter; parsing as passage + questions");

      // split passage and question block at the first delimiter line
      const idx = normalized.search(delimRegex);
      const passage = normalized.slice(0, idx).trim();
      const after = normalized.slice(idx).replace(delimRegex, '').trim();

      if (!passage) {
        allErrors.push({ reason: "Detected delimiter but passage is empty" });
        console.warn("[admin/lms/import] passage empty after delimiter detection");
      } else if (!after) {
        allErrors.push({ reason: "Detected delimiter but question block is empty" });
        console.warn("[admin/lms/import] question block empty after delimiter detection");
      } else {
        // Use existing parseQuestionBlocks to parse the questions portion
        const questionBlocks = parseQuestionBlocks(after);
        console.log(`[admin/lms/import] comprehension parsed ${questionBlocks.length} child question blocks`);

        if (!questionBlocks.length) {
          allErrors.push({ reason: "No valid child questions parsed for comprehension" });
        } else {
          parsedCount += questionBlocks.length;

          // Preview: include passage then the raw blocks for children
          previewBlocks.push({ rawBlock: passage });
          questionBlocks.slice(0, 20).forEach(b => {
            // ensure each preview block is object { rawBlock }
            previewBlocks.push({ rawBlock: b.rawBlock || (b.text || "").slice(0, 400) });
          });

          if (!saveToDb) {
            console.log("[admin/lms/import] saveToDb=false; skipping DB inserts, returning preview");
          } else if (!QuestionModel) {
            allErrors.push({ reason: "Question model not available; cannot save to DB" });
            console.warn("[admin/lms/import] Question model missing; skipping DB insert for comprehension");
          } else {
            // build child docs from parsed blocks
            const childDocs = questionBlocks.map(b => {
              // ensure choices shape [{text}]
              const choices = (b.choices || []).map(c => ({ text: (c && c.text) ? String(c.text).trim() : String(c).trim() })).filter(ch => ch.text);
              let ci = (typeof b.correctIndex === "number") ? b.correctIndex : null;
              if (ci === null || ci < 0 || ci >= choices.length) ci = 0;
              return {
                text: (b.text || "Question").trim(),
                choices,
                correctIndex: ci,
                tags: Array.isArray(b.tags) ? b.tags : [],
                difficulty: b.difficulty || "medium",
                source: "import",
                organization: orgId,
                module: moduleName,
                raw: b.rawBlock || "",
                createdAt: new Date()
              };
            });

            try {
              const inserted = await QuestionModel.insertMany(childDocs, { ordered: true });
              const childIds = inserted.map(x => x._id);
              console.log("[admin/lms/import] inserted child question IDs:", childIds.slice(0, 10));

              // create parent comprehension doc
              const parentDoc = {
                text: passage.split("\n").slice(0,1).join(" ").slice(0,120) || "Comprehension passage",
                type: "comprehension",
                passage,
                questionIds: childIds,
                tags: [],
                source: "import",
                organization: orgId,
                module: moduleName,
                createdAt: new Date()
              };

              const parent = await QuestionModel.create(parentDoc);
              console.log("[admin/lms/import] created comprehension parent ID:", parent._id);

              // optionally tag children for easy lookup
              await QuestionModel.updateMany({ _id: { $in: childIds } }, { $addToSet: { tags: `comprehension-${parent._id}` } }).exec();

              insertedParents++;
              insertedChildren += childIds.length;
            } catch (e) {
              console.error("[admin/lms/import] DB insert failed for comprehension:", e && (e.stack || e));
              allErrors.push({ reason: "DB insert failed for comprehension", error: String(e && e.message) });
            }
          } // end saveToDb && QuestionModel
        } // end has question blocks
      } // end passage/after check

    } else {
      // fallback: parse as single-question blocks
      console.log("[admin/lms/import] no comprehension delimiter found; parsing single-question blocks");
      const blocks = parseQuestionBlocks(content);
      console.log(`[admin/lms/import] parseQuestionBlocks returned ${blocks.length} blocks`);
      parsedCount += blocks.length;

      // preview: map to { rawBlock } objects
      blocks.slice(0, 20).forEach(b => previewBlocks.push({ rawBlock: b.rawBlock || (b.text || "").slice(0, 400) }));

      if (blocks.length === 0) {
        allErrors.push({ reason: "No valid question blocks parsed" });
      } else if (saveToDb && QuestionModel) {
        // prepare docs and insert
        const toInsert = blocks.map(b => {
          const choices = (b.choices || []).map(c => ({ text: (c && c.text) ? String(c.text).trim() : String(c).trim() })).filter(ch => ch.text);
          let ci = (typeof b.correctIndex === "number") ? b.correctIndex : null;
          if (ci === null || ci < 0 || ci >= choices.length) ci = 0;
          return {
            text: (b.text || "Question").trim(),
            choices,
            correctIndex: ci,
            tags: ["imported"],
            source: "import",
            raw: b.rawBlock || "",
            organization: orgId,
            module: moduleName,
            createdAt: new Date()
          };
        });

        try {
          const inserted = await QuestionModel.insertMany(toInsert, { ordered: true });
          console.log("[admin/lms/import] inserted single-question IDs (sample):", inserted.slice(0,10).map(x => x._id));
          insertedChildren += inserted.length;
        } catch (e) {
          console.error("[admin/lms/import] DB insert failed for single questions:", e && (e.stack || e));
          allErrors.push({ reason: "DB insert failed for single questions", error: String(e && e.message) });
        }
      } else if (saveToDb && !QuestionModel) {
        allErrors.push({ reason: "Question model not available; cannot save to DB" });
        console.warn("[admin/lms/import] cannot save single questions: Question model missing");
      } else {
        console.log("[admin/lms/import] saveToDb=false; not saving single questions to DB");
      }
    }

    // build summary
    const summary = {
      parsedFiles: 1,
      parsedItems: parsedCount,
      insertedParents,
      insertedChildren,
      errors: allErrors
    };

    console.log("[admin/lms/import] summary:", summary);

    // Compute flags for rendering
    const totalInserted = insertedParents + insertedChildren;
    const savedToDbFlag = saveToDb && totalInserted > 0 && allErrors.length === 0;
    const dbErrForRender = allErrors.length ? allErrors : null;

    // render the existing admin view summary (the app uses admin/lms_import_summary or admin/lms_import)
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return safeRender(req, res, "admin/lms_import_summary", {
        title: "Import summary",
        detected: parsedCount,
        blocks: previewBlocks, // array of { rawBlock: "..." } matching the template
        savedToDb: savedToDbFlag,
        inserted: totalInserted,
        dbSkipped: !saveToDb,
        dbErr: dbErrForRender,
        selectedOrgId: req.body && req.body.orgId ? req.body.orgId : null,
        selectedModule: moduleName
      });
    }

    return res.json({ success: true, parsed: parsedCount, savedToDb: savedToDbFlag, inserted: totalInserted, errors: allErrors });
  } catch (err) {
    console.error("[admin/lms/import] unexpected error:", err && (err.stack || err));
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(500).send("Import failed");
    }
    return res.status(500).json({ error: "Import failed", detail: String(err && err.message) });
  }
});


/**
 * GET /admin/lms/quizzes
 * Build a sources/tags summary with counts that matches the admin template shape:
 * sources: [{ source, count }], tags: [{ tag, count }]
 */
router.get("/lms/quizzes", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    let Question;
    try {
      Question = (await import("../models/question.js")).default;
    } catch (e) {
      Question = null;
    }

    let sources = [];
    let tags = [];

    if (Question) {
      // aggregate sources with counts
      const sourceAgg = await Question.aggregate([
        { $group: { _id: "$source", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]).catch(() => []);
      sources = (sourceAgg || []).map(r => ({ source: r._id || "unknown", count: r.count || 0 }));

      // tags may be an array on each document: unwind then group
      const tagAgg = await Question.aggregate([
        { $unwind: { path: "$tags", preserveNullAndEmptyArrays: false } },
        { $group: { _id: "$tags", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]).catch(() => []);
      tags = (tagAgg || []).map(r => ({ tag: r._id || "untagged", count: r.count || 0 }));
    }

    return safeRender(req, res, "admin/lms_quizzes", { title: "Manage Quizzes", sources: sources || [], tags: tags || [] });
  } catch (err) {
    console.error("[admin/lms/quizzes] error:", err && (err.stack || err));
    return res.status(500).send("Failed to load quizzes");
  }
});

/**
 * POST /admin/lms/quizzes/delete
 * (alias route used by client-side form/buttons). Accepts body: { type: 'source'|'tag'|'all', value }
 * If type === 'source' and value provided -> deletes by source
 * If type === 'tag' and value provided -> deletes by tag
 * Else deletes ALL questions
 */
/**
 * POST /admin/lms/quizzes/delete
 * Legacy path used by the Manage UI. Accepts form fields:
 *  - type: "source" | "tag" | (omit for all)
 *  - value: the value for the type
 *
 * This duplicates the delete-all behaviour so the UI's form (which posts to /delete)
 * works without changing the template.
 */
router.post("/lms/quizzes/delete", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    // ensure body parser is enabled in app (express.urlencoded/json)
    const filterType = req.body && (req.body.type || req.body.filter);
    const value = req.body && (req.body.value || req.body.value);

    // load Question model
    let Question;
    try {
      Question = (await import("../models/question.js")).default;
    } catch (e) {
      Question = null;
    }

    if (!Question) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(500).send("Question model not found on server; cannot delete from DB.");
      }
      return res.status(500).json({ error: "Question model not found" });
    }

    let filter = {};
    if (filterType === "source" && value) {
      filter = { source: value };
    } else if (filterType === "tag" && value) {
      // tag might be stored as array; use $in for safety
      filter = { tags: value };
    } else {
      filter = {}; // delete all
    }

    const deleteRes = await Question.deleteMany(filter);
    console.log(`[admin/lms/quizzes/delete] deleted ${deleteRes.deletedCount} questions (filter: ${JSON.stringify(filter)})`);

    // redirect back to manage page (same as delete-all did)
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.redirect("/admin/lms/quizzes?deleted=" + encodeURIComponent(deleteRes.deletedCount));
    }
    return res.json({ deleted: deleteRes.deletedCount, filter });
  } catch (err) {
    console.error("[admin/lms/quizzes/delete] error:", err && (err.stack || err));
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(500).send("Failed to delete questions");
    }
    return res.status(500).json({ error: "delete failed", detail: String(err.message || err) });
  }
});

// keep the old delete-all endpoint for API callers (backwards compatible)
router.post("/lms/quizzes/delete-all", ensureAuth, ensureAdmin, async (req, res) => {
  // reuse the delete logic above by forwarding the request
  return router.handle(req, res);
});

// other admin routes below (user listing, visits, etc). Keep your existing handlers.
router.get("/users", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();
    return safeRender(req, res, "admin/users", { title: "Admin · Users", users });
  } catch (err) {
    console.error("[admin/users] error:", err && (err.stack || err));
    return res.status(500).send("Failed to load users");
  }
});

export default router;
