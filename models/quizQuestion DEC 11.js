// models/quizQuestion.js
import mongoose from "mongoose";

const QuizQuestionSchema = new mongoose.Schema({
  text: { type: String, required: true, index: true },
  choices: [{ type: String, required: true }],
  answerIndex: { type: Number, required: true }, // 0..3
  tags: [{ type: String }],
  difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
  instructions: { type: String, default: "" },
  source: { type: String, default: "import" },
  createdAt: { type: Date, default: Date.now },
}, { strict: true });

export default mongoose.models.QuizQuestion || mongoose.model("QuizQuestion", QuizQuestionSchema);
