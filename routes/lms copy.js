// routes/lms.js
import { Router } from "express";
import Course from "../models/course.js";
import Module from "../models/module.js";
import Lesson from "../models/lesson.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// Catalog: GET /lms
router.get("/", async (req, res) => {
  try {
    const courses = await Course.find({ published: true }).sort({ createdAt: -1 }).lean();
    return res.render("lms/index", { title: "Responsibility LMS", courses, user: req.user || null });
  } catch (err) {
    console.error("[lms] catalog error:", err && (err.stack || err));
    return res.status(500).send("Failed to load LMS catalog");
  }
});

// Course detail: GET /lms/course/:slug
router.get("/course/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const course = await Course.findOne({ slug }).populate({
      path: "sections",
      options: { sort: { order: 1 } },
      populate: { path: "lessons", options: { sort: { order: 1 } } }
    }).lean();

    if (!course) return res.status(404).send("Course not found");

    return res.render("lms/course", { title: course.title, course, user: req.user || null });
  } catch (err) {
    console.error("[lms] course error:", err && (err.stack || err));
    return res.status(500).send("Failed to load course");
  }
});

// Learn a lesson: GET /lms/learn/:courseId/:lessonId
router.get("/learn/:courseId/:lessonId", ensureAuth, async (req, res) => {
  try {
    const { courseId, lessonId } = req.params;
    const lesson = await Lesson.findById(lessonId).populate({
      path: "module",
      populate: { path: "course" }
    }).lean();

    if (!lesson) return res.status(404).send("Lesson not found");

    // find other lessons in module for sidebar
    const module = await Module.findById(lesson.module._id).populate({ path: "lessons", options: { sort: { order: 1 } } }).lean();

    return res.render("lms/lesson", {
      title: lesson.title,
      lesson,
      module,
      course: lesson.module.course || null,
      user: req.user || null
    });
  } catch (err) {
    console.error("[lms] lesson error:", err && (err.stack || err));
    return res.status(500).send("Failed to load lesson");
  }
});

export default router;
