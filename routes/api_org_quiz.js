// routes/api_org_quiz.js
import { Router } from "express";
import crypto from "crypto";
import mongoose from "mongoose";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import QuizQuestion from "../models/quizQuestion.js"; // your model
import Attempt from "../models/attempt.js";
import ExamInstance from "../models/examInstance.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(crypto.randomInt(0, i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// POST /api/org/:slug/quiz/generate
router.post("/:slug/quiz/generate", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const moduleName = String(req.body.module || "general").trim();
    const count = Math.max(1, Math.min(50, Number(req.body.count || 20)));
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).json({ error: "org not found" });

    // membership check
    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).json({ error: "not a member" });

    // exclude recent qIds for this user + module to reduce repeats
    const lastAttempt = await Attempt.findOne({ userId: req.user._id, organization: org._id, module: moduleName }).sort({ createdAt: -1 }).lean();
    const exclude = lastAttempt && Array.isArray(lastAttempt.questionIds) ? lastAttempt.questionIds.map(String) : [];

    // build match: org-specific OR global (organization null)
    const match = { module: moduleName, $or: [{ organization: null }, { organization: org._id }] };
    if (exclude.length) match._id = { $nin: exclude.map(id => mongoose.Types.ObjectId(id)) };

    // try to sample `count` questions, fallback to allowing previous if pool small
    let docs = await QuizQuestion.aggregate([{ $match: match }, { $sample: { size: count } }]).allowDiskUse(true);
    if (!docs || docs.length < count) {
      docs = await QuizQuestion.aggregate([{ $match: { module: moduleName, $or: [{ organization: null }, { organization: org._id }] } }, { $sample: { size: count } }]).allowDiskUse(true);
    }

    if (!docs || !docs.length) return res.status(404).json({ error: "no questions available" });

    // For each question, create a random choicesOrder mapping shown-index -> original-index
    const questionIds = [];
    const choicesOrder = [];
    const series = [];

    for (const q of docs) {
      questionIds.push(q._id);
      const n = (q.choices || []).length;
      const indices = Array.from({ length: n }, (_, i) => i);
      shuffleArray(indices);
      choicesOrder.push(indices);
      const shownChoices = indices.map(i => ({ text: q.choices[i] }));
      series.push({ questionId: String(q._id), text: q.text, choices: shownChoices });
    }

    const examId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + (1000 * 60 * 60)); // 1 hour

    // persist
    await ExamInstance.create({
      examId, org: org._id, module: moduleName, user: req.user._id, questionIds, choicesOrder, expiresAt, createdByIp: req.ip
    });

    // persist a starter Attempt record (answers empty until submit). Good for progress tracking.
    await Attempt.create({ userId: req.user._id, organization: org._id, module: moduleName, questionIds, startedAt: new Date(), maxScore: questionIds.length });

    return res.json({ examId, expiresAt, series });
  } catch (e) {
    console.error("[api_org_quiz/generate] error:", e && e.stack);
    return res.status(500).json({ error: "failed to generate quiz" });
  }
});

// POST /api/org/:slug/quiz/submit

/*
router.post("/:slug/quiz/submit", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const { examId, answers = [] } = req.body || {};
    if (!examId) return res.status(400).json({ error: "examId required" });
    if (!Array.isArray(answers) || !answers.length) return res.status(400).json({ error: "answers required" });

    const exam = await ExamInstance.findOne({ examId }).lean();
    if (!exam) return res.status(404).json({ error: "exam not found" });
    if (exam.expiresAt && new Date() > new Date(exam.expiresAt)) return res.status(400).json({ error: "exam expired" });

    // ensure membership and ownership
    const org = await Organization.findById(exam.org).lean();
    if (!org) return res.status(404).json({ error: "org not found" });
    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).json({ error: "not a member" });

    // load questions
    const qDocs = await QuizQuestion.find({ _id: { $in: exam.questionIds } }).lean();
    const qById = {};
    for (const q of qDocs) qById[String(q._id)] = q;

    // compute score by mapping shown-index -> original-index using choicesOrder
    let correct = 0;
    const details = [];

    // build index of exam.questionIds for consistent mapping
    for (let i = 0; i < exam.questionIds.length; i++) {
      const qid = String(exam.questionIds[i]);
      const q = qById[qid];
      const mapping = Array.isArray(exam.choicesOrder && exam.choicesOrder[i]) ? exam.choicesOrder[i] : null;
      const given = answers.find(a => String(a.questionId) === qid);
      const yourShownIndex = (given && Number.isFinite(Number(given.choiceIndex))) ? Number(given.choiceIndex) : null;
      // map shown -> original index
      const mappedIndex = (mapping && yourShownIndex !== null && mapping[yourShownIndex] !== undefined) ? mapping[yourShownIndex] : null;
      const correctIndex = (q && typeof q.answerIndex === "number") ? q.answerIndex : null;
      const isCorrect = (mappedIndex !== null && correctIndex !== null && mappedIndex === correctIndex);
      if (isCorrect) correct++;
      details.push({ questionId: qid, yourShownIndex, mappedIndex, correctIndex, correct: !!isCorrect });
    }

    const total = exam.questionIds.length;
    const percentage = Math.round((correct / Math.max(1, total)) * 100);
    const passThreshold = Number(process.env.LMS_PASS_PERCENT || 60);
    const passed = percentage >= passThreshold;

    // update Attempt record (latest one) and mark finished
    await Attempt.findOneAndUpdate({ userId: req.user._id, organization: org._id, module: exam.module }, {
      $set: { finishedAt: new Date(), score: correct, maxScore: total, passed }
    }, { sort: { createdAt: -1 }, upsert: false });

    return res.json({ examId, score: correct, total, percentage, passed, details });
  } catch (e) {
    console.error("[api_org_quiz/submit] error:", e && e.stack);
    return res.status(500).json({ error: "submit failed" });
  }
});*/


// routes/api_org_quiz.js — replace the existing POST "/:slug/quiz/submit" handler with this

// POST /api/org/:slug/quiz/submit  (replace the old handler with this)
router.post("/:slug/quiz/submit", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const { examId, answers = [] } = req.body || {};
    if (!examId) return res.status(400).json({ error: "examId required" });
    if (!Array.isArray(answers) || !answers.length) return res.status(400).json({ error: "answers required" });

    // find the exam instance (must exist)
    const exam = await ExamInstance.findOne({ examId }).lean();
    if (!exam) return res.status(404).json({ error: "exam not found" });

    // check expiry
    if (exam.expiresAt && new Date() > new Date(exam.expiresAt)) {
      return res.status(400).json({ error: "exam expired" });
    }

    // ensure membership (user must belong to org)
    const org = await Organization.findById(exam.org).lean();
    if (!org) return res.status(404).json({ error: "org not found" });

    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).json({ error: "not a member" });

    // load the quiz questions referenced in the exam
    const qDocs = await QuizQuestion.find({ _id: { $in: exam.questionIds } }).lean();
    const qById = {};
    for (const q of qDocs) qById[String(q._id)] = q;

    // score: map shownIndex -> originalIndex using exam.choicesOrder
    let correctCount = 0;
    const details = [];

    for (let i = 0; i < (exam.questionIds || []).length; i++) {
      const qid = String(exam.questionIds[i]);
      const q = qById[qid] || null;

      // mapping: for question i, exam.choicesOrder[i] gives mapping shownIndex -> originalIndex
      const mapping = Array.isArray(exam.choicesOrder && exam.choicesOrder[i]) ? exam.choicesOrder[i] : null;

      // find the submitted answer for this question (answers array contains objects with questionId + choiceIndex (shown index) )
      const given = answers.find(a => String(a.questionId) === qid);
      const yourShownIndex = (given && Number.isFinite(Number(given.choiceIndex))) ? Number(given.choiceIndex) : null;

      // mappedIndex = original index in the stored question choices array
      const mappedIndex = (mapping && yourShownIndex !== null && mapping[yourShownIndex] !== undefined)
        ? mapping[yourShownIndex]
        : null;

      // get the canonical correct index from question doc (answerIndex / correctIndex)
      const correctIndex = (q && (typeof q.answerIndex === "number" || typeof q.answerIndex === "string"))
        ? Number(q.answerIndex)
        : (q && typeof q.correctIndex === "number" ? q.correctIndex : null);

      const isCorrect = (mappedIndex !== null && correctIndex !== null && mappedIndex === correctIndex);
      if (isCorrect) correctCount++;

      // textual choices (original stored choices)
      const correctChoiceText = (q && Array.isArray(q.choices) && typeof correctIndex === "number" && q.choices[correctIndex] !== undefined)
        ? (typeof q.choices[correctIndex] === "string" ? q.choices[correctIndex] : (q.choices[correctIndex].text || q.choices[correctIndex]))
        : null;

      const yourAnswerText = (q && Array.isArray(q.choices) && mappedIndex !== null && q.choices[mappedIndex] !== undefined)
        ? (typeof q.choices[mappedIndex] === "string" ? q.choices[mappedIndex] : (q.choices[mappedIndex].text || q.choices[mappedIndex]))
        : null;

      details.push({
        questionId: qid,
        questionText: q ? q.text : null,
        yourShownIndex,
        mappedIndex,
        correctIndex,
        yourAnswerText,
        correctAnswerText: correctChoiceText,
        correct: !!isCorrect
      });
    }

    const total = (exam.questionIds || []).length;
    const percentage = Math.round((correctCount / Math.max(1, total)) * 100);
    const passThreshold = Number(process.env.LMS_PASS_PERCENT || 60);
    const passed = percentage >= passThreshold;

    // 1) Update ExamInstance (mark finished + store summary)
    try {
      await ExamInstance.updateOne(
        { _id: exam._id },
        {
          $set: {
            finishedAt: new Date(),
            score: correctCount,
            percentage,
            passed,
            finishedByIp: req.ip,
            // small summary for quick admin list checks
            answersSummary: details.map(d => ({
              questionId: d.questionId,
              yourShownIndex: d.yourShownIndex,
              mappedIndex: d.mappedIndex,
              correct: d.correct
            }))
          }
        }
      );
    } catch (e) {
      console.warn("[submit] failed updating ExamInstance:", e && (e.stack || e));
    }

    // 2) Update the Attempt record (latest attempt for that user/org/module)
    // Save an answers array that includes `choiceIndex` so the admin view can read it.
    try {
      const attemptAnswers = details.map(d => ({
        questionId: d.questionId,
        // preserve the shown index selection so admin UI (which expects choiceIndex) can show what the user clicked
        choiceIndex: (d.yourShownIndex !== undefined && d.yourShownIndex !== null) ? d.yourShownIndex : null,
        mappedIndex: d.mappedIndex,
        correctIndex: d.correctIndex,
        yourAnswerText: d.yourAnswerText,
        correctAnswerText: d.correctAnswerText,
        correct: d.correct
      }));

      await Attempt.findOneAndUpdate(
        { userId: req.user._id, organization: org._id, module: exam.module },
        {
          $set: {
            finishedAt: new Date(),
            score: correctCount,
            maxScore: total,
            passed,
            answers: attemptAnswers
          }
        },
        { sort: { createdAt: -1 }, upsert: false }
      );
    } catch (e) {
      console.warn("[submit] failed updating Attempt:", e && (e.stack || e));
    }

    // final response
    return res.json({
      examId,
      score: correctCount,
      total,
      percentage,
      passed,
      details
    });
  } catch (e) {
    console.error("[api_org_quiz/submit] error:", e && (e.stack || e));
    return res.status(500).json({ error: "submit failed" });
  }
});



// INSERT into routes/api_org_quiz.js (near other handlers)
// requires ExamInstance and QuizQuestion imported at top of file
// ensure ensureAuth is applied

// GET /api/org/:slug/quiz?examId=...
// GET /api/org/:slug/quiz?examId=...
router.get("/:slug/quiz", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const examId = String(req.query.examId || "").trim();
    if (!examId) return res.status(400).json({ error: "examId required" });

    // find exam instance
    const exam = await ExamInstance.findOne({ examId }).lean();
    if (!exam) return res.status(404).json({ error: "exam not found" });

    // verify org slug matches exam.org
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).json({ error: "org not found" });
    if (String(exam.org) !== String(org._id) && String(org._id) !== String(req.query.org)) {
      // allow if you want to be flexible, else block
      // return res.status(403).json({ error: "exam not for this org" });
    }

    // load all referenced question ids (collect real ids from exam.questionIds)
    const rawIds = Array.isArray(exam.questionIds) ? exam.questionIds.map(String) : [];
    const childIds = rawIds
      .filter(id => !id.startsWith("parent:"))
      .map(id => {
        try { return mongoose.Types.ObjectId(id); } catch (e) { return null; }
      })
      .filter(Boolean);

    // also collect parent ids
    const parentIds = rawIds
      .filter(id => id.startsWith("parent:"))
      .map(id => id.replace(/^parent:/, ""))
      .map(id => {
        try { return mongoose.Types.ObjectId(id); } catch (e) { return null; }
      })
      .filter(Boolean);

    // fetch all child and parent docs in one go
    const docs = await QuizQuestion.find({ $or: [{ _id: { $in: childIds } }, { _id: { $in: parentIds } }] }).lean();
    const docsById = {};
    for (const d of docs) docsById[String(d._id)] = d;

    // Build series preserving order in exam.questionIds
    const series = [];

    for (let i = 0; i < rawIds.length; i++) {
      const rid = rawIds[i];

      // parent marker
      if (typeof rid === "string" && rid.startsWith("parent:")) {
        const pid = rid.replace(/^parent:/, "");
        const parentDoc = docsById[pid] || null;

        // build children array by scanning subsequent rawIds until next parent or end
        const children = [];
        // find index of this parent in rawIds (i) and then collect following ids until next parent marker
        let j = i + 1;
        while (j < rawIds.length && !String(rawIds[j]).startsWith("parent:")) {
          const childIdStr = String(rawIds[j]);
          const childDoc = docsById[childIdStr] || null;
          const mapping = Array.isArray(exam.choicesOrder && exam.choicesOrder[j]) ? exam.choicesOrder[j] : null;

          if (childDoc) {
            // build shown choices using mapping if present
            const shownChoices = [];
            if (Array.isArray(childDoc.choices) && mapping && mapping.length) {
              for (let si = 0; si < mapping.length; si++) {
                const origIdx = mapping[si];
                const c = childDoc.choices[origIdx];
                shownChoices.push(typeof c === "string" ? { text: c } : { text: (c && (c.text || "")) });
              }
            } else if (Array.isArray(childDoc.choices)) {
              for (const c of childDoc.choices) {
                shownChoices.push(typeof c === "string" ? { text: c } : { text: (c && (c.text || "")) });
              }
            }

            children.push({
              questionId: String(childDoc._id),
              text: childDoc.text || "",
              choices: shownChoices
            });
          } else {
            // child missing from DB, still push placeholder so client numbering stays consistent
            children.push({
              questionId: childIdStr,
              text: "(question missing)",
              choices: []
            });
          }
          j++;
        }

        // push the comprehension parent object (include passage & children)
        series.push({
          type: "comprehension",
          questionId: `parent:${pid}`,
          passage: parentDoc ? (parentDoc.passage || parentDoc.text || "") : "",
          title: parentDoc ? (parentDoc.text || "") : "(passage missing)",
          children // array of child objects
        });

        // advance i to j-1 (outer loop will increment)
        i = j - 1;
        continue;
      }

      // normal question (not part of a parent)
      const qid = rid;
      const qDoc = docsById[qid] || null;
      const mapping = Array.isArray(exam.choicesOrder && exam.choicesOrder[i]) ? exam.choicesOrder[i] : null;

      const shownChoices = [];
      if (qDoc && Array.isArray(qDoc.choices) && mapping && mapping.length) {
        for (let si = 0; si < mapping.length; si++) {
          const origIdx = mapping[si];
          const c = qDoc.choices[origIdx];
          shownChoices.push(typeof c === "string" ? { text: c } : { text: (c && (c.text || "")) });
        }
      } else if (qDoc && Array.isArray(qDoc.choices)) {
        for (const c of (qDoc.choices || [])) {
          shownChoices.push(typeof c === "string" ? { text: c } : { text: (c && (c.text || "")) });
        }
      }

      series.push({
        questionId: qDoc ? String(qDoc._id) : qid,
        text: qDoc ? qDoc.text : "(question missing)",
        choices: shownChoices
      });
    }

    return res.json({ examId: exam.examId, series, expiresAt: exam.expiresAt || null });
  } catch (err) {
    console.error("[GET /api/org/:slug/quiz] error:", err && (err.stack || err));
    return res.status(500).json({ error: "failed to load exam" });
  }
});



export default router;
