// routes/api_lms.js
import { Router } from "express";
import mongoose from "mongoose";
import Course from "../models/course.js";
import Module from "../models/module.js";
import Lesson from "../models/lesson.js";
import Quiz from "../models/quiz.js";
import Question from "../models/question.js";
import Enrollment from "../models/enrollment.js";
import Attempt from "../models/attempt.js";
import Certificate from "../models/certificate.js";
import { ensureAuth } from "../middleware/authGuard.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const router = Router();

/**
 * POST /api/lms/enroll
 * Body: { courseId }
 */
router.post("/enroll", ensureAuth, async (req, res) => {
  try {
    const userId = req.user._id;
    const { courseId } = req.body;
    if (!courseId) return res.status(400).json({ error: "Missing courseId" });

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ error: "Course not found" });

    const [enrollment] = await Enrollment.findOneAndUpdate(
      { userId, courseId },
      { $setOnInsert: { startedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).then(doc => doc ? [doc] : []);

    // if upsert returned nothing due to driver differences, fetch now
    let e = enrollment;
    if (!e) e = await Enrollment.findOne({ userId, courseId });

    return res.json({ success: true, enrollment: e });
  } catch (err) {
    console.error("/api/lms/enroll error:", err && (err.stack || err));
    return res.status(500).json({ error: "enroll failed" });
  }
});

/**
 * GET /api/lms/progress?courseId=...
 */
router.get("/progress", ensureAuth, async (req, res) => {
  try {
    const userId = req.user._id;
    const courseId = req.query.courseId;
    if (!courseId) return res.status(400).json({ error: "Missing courseId" });

    const course = await Course.findById(courseId).populate({ path: "sections", populate: { path: "lessons" } });
    if (!course) return res.status(404).json({ error: "Course not found" });

    const totalLessons = (course.sections || []).reduce((acc, s) => acc + ((s.lessons && s.lessons.length) || 0), 0);
    const enrollment = await Enrollment.findOne({ userId, courseId }).lean();
    const completed = (enrollment && (enrollment.completedLessons || []).length) || 0;
    const progress = totalLessons === 0 ? 0 : Math.round((completed / totalLessons) * 100);

    return res.json({ totalLessons, completed, progress, enrollment: enrollment || null });
  } catch (err) {
    console.error("/api/lms/progress error:", err && (err.stack || err));
    return res.status(500).json({ error: "progress failed" });
  }
});

/**
 * POST /api/lms/quiz/submit
 * Body: { quizId, answers: [{ questionId, answer }] }
 * Grading logic implemented server-side.
 */
router.post("/quiz/submit", ensureAuth, async (req, res) => {
  try {
    const userId = req.user._id;
    const { quizId, answers } = req.body;
    if (!quizId) return res.status(400).json({ error: "Missing quizId" });
    const quiz = await Quiz.findById(quizId).populate("questions").lean();
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });

    // compute score
    let score = 0;
    let maxScore = 0;
    const answerMap = new Map((answers || []).map(a => [String(a.questionId), a.answer]));

    for (const q of (quiz.questions || [])) {
      const qid = String(q._id);
      const provided = answerMap.has(qid) ? answerMap.get(qid) : null;
      const points = q.points || 1;
      maxScore += points;

      if (q.type === "mcq") {
        const correctIndex = (q.choices || []).findIndex(c => c.correct);
        if (provided !== null && provided !== undefined && Number(provided) === correctIndex) {
          score += points;
        }
      } else if (q.type === "multi") {
        const correctIdxs = (q.choices || []).map((c, i) => c.correct ? i : -1).filter(i => i >= 0);
        const providedArr = Array.isArray(provided) ? provided.map(v => Number(v)) : [];
        if (correctIdxs.length === 0) {
          // nothing set as correct — ignore
        } else {
          const matched = providedArr.filter(v => correctIdxs.includes(v)).length;
          // partial credit: proportion matched, but penalize extra answers
          const extra = Math.max(0, providedArr.length - matched);
          const raw = Math.max(0, (matched - extra) / correctIdxs.length);
          score += points * raw;
        }
      } else if (q.type === "short") {
        // expected answer is first choice text
        const expected = (q.choices && q.choices[0] && q.choices[0].text) ? String(q.choices[0].text).trim().toLowerCase() : "";
        const given = (provided || "").toString().trim().toLowerCase();
        if (expected && given) {
          if (given === expected) score += points;
          else {
            // tiny fuzzy match: token overlap
            const a = new Set(expected.split(/\s+/));
            const b = new Set(given.split(/\s+/));
            let common = 0;
            for (const t of b) if (a.has(t)) common++;
            if (common / Math.max(1, a.size) >= 0.6) score += points * 0.75;
          }
        }
      }
    }

    // Save attempt
    const attempt = await Attempt.create({
      userId, quizId, answers: answers || [], score: Number(score), maxScore: Number(maxScore),
      startedAt: new Date(), finishedAt: new Date(), passed: false
    });

    const percent = maxScore === 0 ? 0 : (score / maxScore) * 100;
    const passed = percent >= (quiz.passingPercent || 70);

    attempt.passed = passed;
    await attempt.save();

    // Mark lesson completed (if quiz is attached to a lesson)
    if (quiz.lesson) {
      // find the lesson and module/course
      const lesson = await Lesson.findById(quiz.lesson).lean();
      if (lesson) {
        const module = await Module.findById(lesson.module).lean();
        const courseId = module && module.course ? module.course : null;

        // add completed lesson to enrollment
        if (courseId) {
          await Enrollment.findOneAndUpdate(
            { userId, courseId },
            { $addToSet: { completedLessons: lesson._id } },
            { upsert: true }
          );

          // recompute progress
          const course = await Course.findById(courseId).populate({ path: "sections", populate: { path: "lessons" } });
          const totalLessons = (course.sections || []).reduce((acc, s) => acc + ((s.lessons && s.lessons.length) || 0), 0);
          const enrollment = await Enrollment.findOne({ userId, courseId });
          const completed = (enrollment && (enrollment.completedLessons || []).length) || 0;
          const newProgress = totalLessons === 0 ? 0 : Math.round((completed / totalLessons) * 100);
          await Enrollment.updateOne({ userId, courseId }, { $set: { progress: newProgress }, $setOnInsert: { startedAt: new Date() } });
        }
      }
    }

    // If quiz is final (heuristic: quiz.title includes 'final' or 'exam'), issue certificate if passed
    let certificate = null;
    if (passed && quiz.title && /final|exam|final exam/i.test(quiz.title)) {
      const serial = `CRP-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const pdfDir = path.join(process.cwd(), "data", "certificates");
      if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

      // simple text-pdf fallback if pdfkit not installed
      let pdfPath = path.join(pdfDir, `${serial}.txt`);
      try {
        // prefer pdfkit if available
        const PDFDocument = (await import("pdfkit")).default;
        const doc = new PDFDocument({ size: "A4", margin: 50 });
        pdfPath = path.join(pdfDir, `${serial}.pdf`);
        const out = fs.createWriteStream(pdfPath);
        doc.pipe(out);

        doc.fontSize(20).text("CRIPFCnt Responsibility Certificate", { align: "center" });
        doc.moveDown();
        doc.fontSize(14).text(`This certifies that ${req.user.firstName || req.user.displayName || req.user.email} has completed "${quiz.title}" and earned certification.`, { align: "left" });
        doc.moveDown();
        doc.fontSize(12).text(`Serial: ${serial}`);
        doc.end();

        // wait for stream finish
        await new Promise((resolve, reject) => out.on("finish", resolve).on("error", reject));
      } catch (e) {
        // fallback: write a txt certificate
        pdfPath = path.join(pdfDir, `${serial}.txt`);
        fs.writeFileSync(pdfPath, `CRIPFCnt Certificate\n\nName: ${req.user.firstName || req.user.displayName || req.user.email}\nCourse/Quiz: ${quiz.title}\nSerial: ${serial}\nIssued: ${new Date().toISOString()}`);
      }

      certificate = await Certificate.create({
        userId, courseId: (quiz.lesson ? (await Lesson.findById(quiz.lesson)).module : null), // fallback: set null or course id later
        pdfPath,
        serial,
        issuedAt: new Date()
      });
    }

    return res.json({
      attemptId: attempt._id,
      score: Number(score),
      maxScore: Number(maxScore),
      percent: Math.round((score / Math.max(1, maxScore)) * 100),
      passed,
      certificate: certificate ? { serial: certificate.serial, pdfPath: certificate.pdfPath } : null
    });
  } catch (err) {
    console.error("/api/lms/quiz/submit error:", err && (err.stack || err));
    return res.status(500).json({ error: "quiz submit failed", detail: String(err?.message || err) });
  }
});

/**
 * GET /api/lms/certificate/:serial
 * Streams certificate file if owned by user or if admin
 */
router.get("/certificate/:serial", ensureAuth, async (req, res) => {
  try {
    const serial = String(req.params.serial || "");
    if (!serial) return res.status(400).send("Missing serial");

    const cert = await Certificate.findOne({ serial });
    if (!cert) return res.status(404).send("Certificate not found");

    const isAdmin = (new Set((process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()))).has((req.user.email || "").toLowerCase());
    if (String(cert.userId) !== String(req.user._id) && !isAdmin) return res.status(403).send("Forbidden");

    const p = cert.pdfPath;
    if (!p || !fs.existsSync(p)) return res.status(404).send("Certificate file not found");

    const ext = path.extname(p).toLowerCase();
    if (ext === ".pdf") {
      res.setHeader("Content-Type", "application/pdf");
      return fs.createReadStream(p).pipe(res);
    }
    // fallback to text
    res.setHeader("Content-Type", "text/plain");
    return fs.createReadStream(p).pipe(res);
  } catch (err) {
    console.error("/api/lms/certificate error:", err && (err.stack || err));
    return res.status(500).send("Failed to retrieve certificate");
  }
});

export default router;
