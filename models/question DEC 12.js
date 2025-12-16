// models/question.js
import mongoose from "mongoose";

const ChoiceSchema = new mongoose.Schema({
  label: String,    // optional, you aren't using label but keeping for compatibility
  text: String
}, { _id: false });

const QuestionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  choices: [ChoiceSchema],
  correctIndex: { type: Number, required: true },

  // NEW FIELDS FOR ORGANIZATION / MODULE SUPPORT
  organization: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Organization",
    default: null,
    index: true                       // makes org-level quiz filtering faster
  },

  module: {
    type: String,
    default: "general",
    index: true                       // required to filter module-specific questions
  },

  tags: [String],
  difficulty: { type: String, default: null },
  source: { type: String, default: "import" },
  raw: { type: String, default: null },       // optional: store raw block for debugging
  createdAt: { type: Date, default: () => new Date() }
});

export default mongoose.models.Question || mongoose.model("Question", QuestionSchema);
