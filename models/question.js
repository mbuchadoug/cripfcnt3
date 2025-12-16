// models/question.js
import mongoose from "mongoose";

const ChoiceSchema = new mongoose.Schema({
  label: String,
  text: String
}, { _id: false });

const QuestionSchema = new mongoose.Schema({
  text: { type: String, required: true },

  // for regular questions
  choices: [ChoiceSchema],
  correctIndex: { type: Number, required: function() { return this.type !== 'comprehension'; } },
  title: { type: String, default: null },


  // NEW: comprehension parent support
  type: { type: String, enum: ["question","comprehension"], default: "question", index: true },
  passage: { type: String, default: null }, // full passage for comprehension parent
  questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question" }], // child IDs for parent

  // metadata
  organization: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Organization",
    default: null,
    index: true
  },
  module: {
    type: String,
    default: "general",
    index: true
  },

  tags: [String],
  difficulty: { type: String, default: null },
  source: { type: String, default: "import" },
  raw: { type: String, default: null },
  createdAt: { type: Date, default: () => new Date() }
});

export default mongoose.models.Question || mongoose.model("Question", QuestionSchema);
