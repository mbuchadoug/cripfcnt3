// models/quizQuestion.js
import mongoose from "mongoose";

const QuizQuestionSchema = new mongoose.Schema({
  organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true, default: null }, // null = global
  module: { type: String, index: true, default: "general" },
  text: { type: String, required: true, index: true },
  choices: [{ type: String, required: true }],
  answerIndex: { type: Number, required: true }, // 0..3
  tags: [{ type: String }],
  difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
  instructions: { type: String, default: "" },
  source: { type: String, default: "import" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true });

export default mongoose.models.QuizQuestion || mongoose.model("QuizQuestion", QuizQuestionSchema);
