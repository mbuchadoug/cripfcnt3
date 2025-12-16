// models/quizQuestion.js
import mongoose from "mongoose";

const QuizQuestionSchema = new mongoose.Schema({
  // core question fields (for normal questions)
  text: { type: String, required: true, index: true },

  // allow both usual simple-string choices and omit for parent docs
  choices: [{ type: String }], // not required for comprehension parent

  // make answerIndex optional (parent docs won't have it)
  answerIndex: { type: Number },

  // optional metadata for org/module so this collection can be filtered similarly to Question model
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
    default: null,
    index: true,
  },
  module: {
    type: String,
    default: "general",
    index: true,
  },

  // Comprehension-specific fields
  type: { type: String, enum: ["question", "comprehension"], default: "question", index: true },
  passage: { type: String, default: null }, // the passage text for comprehension parent
  questionIds: [{ type: mongoose.Schema.Types.ObjectId }], // refs to child question docs

  tags: [{ type: String }],
  difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
  instructions: { type: String, default: "" },
  source: { type: String, default: "import" },
  createdAt: { type: Date, default: Date.now },
}, { strict: true });

// Helpful: ensure older code that expects .answerIndex or .correctIndex still works
// You can add virtuals or leave as is. For clarity, we label plain questions with type 'question' (default).

export default mongoose.models.QuizQuestion || mongoose.model("QuizQuestion", QuizQuestionSchema);
