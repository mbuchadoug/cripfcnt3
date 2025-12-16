// scripts/seedResponsibility.js
// Usage: NODE_ENV=development node scripts/seedResponsibility.js
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import Course from "../models/course.js";
import Module from "../models/module.js";
import Lesson from "../models/lesson.js";
import Quiz from "../models/quiz.js";
import Question from "../models/question.js";

const MONGO = process.env.MONGODB_URI;
if (!MONGO) {
  console.error("MONGODB_URI missing in env");
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("Connected to mongo for seeding");

  // create course
  let course = await Course.findOne({ slug: "responsibility-lms" });
  if (course) {
    console.log("Responsibility LMS already seeded");
    process.exit(0);
  }

  course = await Course.create({
    slug: "responsibility-lms",
    title: "RESPONSIBILITY LMS",
    shortDescription: "Learn responsibility as placement — CRIPFCnt structured discipline for individuals and organizations.",
    longDescription: `Welcome to the CRIPFCnt Responsibility Learning System — the first global platform that teaches responsibility as placement.`,
    heroImage: "/static/lms/hero.jpg",
    colorPalette: { gold: "#D4AF37", black: "#0A0A0A", charcoal: "#1B1B1B", white: "#F5F5F5" },
    published: true
  });

  // Modules & lessons content from brief
  const modules = [
    { title: "Introduction & Positioning", lessons: [
      { title: "Welcome — Responsibility is the First Architecture", body: `“Responsibility is the First Architecture of Civilization. Before purpose, before performance, before success - there is responsibility.”\n\nThis LMS introduces placement-based responsibility...` }
    ]},
    { title: "The Science of Responsibility", lessons: [
      { title: "How responsibility interacts with consciousness", body: "How responsibility interacts with consciousness, subconsciousness, interpretation, and purpose. Why responsible people outperform talent, skill, and motivation." }
    ]},
    { title: "The Social Contract Equation", lessons: [
      { title: "Duties, Obligations, Hidden Expectations", body: "Your duties, your non-hierarchical obligations, and hidden expectations placed on visible actors." }
    ]},
    { title: "Placement Responsibility", lessons: [
      { title: "Placement and SCOI", body: "How your choices, associations, reactions, and boundaries affect your SCOI score." }
    ]},
    { title: "Decision-Making Engine", lessons: [
      { title: "Slowing internal loops & reframing", body: "The CRIPFCnt method: Slowing internal loops, reframing interpretation, eliminating bias, and making sovereign decisions." }
    ]},
    { title: "Practical Responsibility", lessons: [
      { title: "Micro-tests & Simulations", body: "Real-world micro-tests, daily scenarios, simulated decisions. Training instinct, not memory." }
    ]},
    { title: "Certification", lessons: [
      { title: "Final Exam (Responsibility Final Exam)", body: "Final exam — multiple choice & short answers. Pass to receive CRIPFCnt Responsibility Certificate." }
    ]},
  ];

  for (let i = 0; i < modules.length; i++) {
    const modData = modules[i];
    const mod = await Module.create({ course: course._id, title: modData.title, order: i });
    const lessonIds = [];
    for (let j = 0; j < modData.lessons.length; j++) {
      const l = modData.lessons[j];
      // For final exam lesson attach a quiz later
      const lesson = await Lesson.create({ module: mod._id, title: l.title, body: l.body, order: j });
      lessonIds.push(lesson._id);
    }
    mod.lessons = lessonIds;
    await mod.save();
    course.sections.push(mod._id);
  }

  await course.save();
  console.log("Course, modules and lessons created.");

  // Create a small final exam quiz (on last module's lesson)
  const finalModule = await Module.findOne({ course: course._id, title: "Certification" });
  const finalLesson = await Lesson.findOne({ module: finalModule._id, title: /Final Exam/i });
  const quiz = await Quiz.create({
    lesson: finalLesson._id,
    title: "Responsibility Final Exam",
    description: "25 question final exam (seed has 5 sample Qs). Passing percent 70",
    passingPercent: 70
  });

  const questionsData = [
    { type: "mcq", text: "In CRIPFCnt, responsibility is best described as:", choices: [{ text: "A moral trait", correct: false }, { text: "A behavioral habit", correct: false }, { text: "A structural placement function", correct: true }, { text: "An emotion", correct: false }], points: 1 },
    { type: "mcq", text: "Placement responsibility most directly affects:", choices: [{ text: "SCOI score", correct: true }, { text: "IQ", correct: false }, { text: "Height", correct: false }, { text: "Random luck", correct: false }], points: 1 },
    { type: "multi", text: "Select items that are part of the Decision-Making Engine:", choices: [{ text: "Slowing internal loops", correct: true }, { text: "Reframing interpretation", correct: true }, { text: "Ignoring feedback", correct: false }, { text: "Eliminating bias", correct: true }], points: 2 },
    { type: "short", text: "Give one word that CRIPFCnt uses to describe responsibility (one word).", choices: [{ text: "placement", correct: true }], points: 2 },
    { type: "mcq", text: "Practical Responsibility exercises aim to train:", choices: [{ text: "Memory recall", correct: false }, { text: "Instinct", correct: true }, { text: "Typing speed", correct: false }, { text: "Pure knowledge", correct: false }], points: 1 }
  ];

  const qIds = [];
  for (const qd of questionsData) {
    const q = await Question.create({ quiz: quiz._id, type: qd.type, text: qd.text, choices: qd.choices, points: qd.points });
    qIds.push(q._id);
  }
  quiz.questions = qIds;
  await quiz.save();

  // update lesson to reference quiz
  finalLesson.quiz = quiz._id;
  await Lesson.updateOne({ _id: finalLesson._id }, { $set: { quiz: quiz._id } });

  console.log("Final exam quiz created with sample questions.");
  console.log("Seeding complete.");
  process.exit(0);
}

run().catch(err => {
  console.error("Seed error:", err && (err.stack || err));
  process.exit(1);
});
