// models/question.js
import mongoose from "mongoose";

const ChoiceSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
  },
  { _id: false }
);

const QuestionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },       // main question text
    choices: { type: [String], required: true },      // array of choice strings
    answerIndex: { type: Number, required: true },    // 0-based index for correct choice
    tags: { type: [String], default: [] },
    difficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
    source: { type: String },                         // optional metadata
    createdAt: { type: Date, default: () => new Date() },
  },
  { collection: "questions" }
);

// Optional: convenience virtual to return choices as objects (not necessary)
QuestionSchema.methods.toClient = function () {
  return {
    id: String(this._id),
    text: this.question,
    choices: (this.choices || []).map((c) => ({ text: c })),
  };
};

export default mongoose.models.Question || mongoose.model("Question", QuestionSchema);
