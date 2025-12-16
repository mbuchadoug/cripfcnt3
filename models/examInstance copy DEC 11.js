// models/examInstance.js
import mongoose from "mongoose";

const ExamInstanceSchema = new mongoose.Schema({
  examId: { type: String, required: true, unique: true, index: true }, // uuid
  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true, default: null },
  module: { type: String, index: true, default: "general" },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, // assigned user (optional until submit)
  questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question" }], // preserved order
  choicesOrder: [{ type: [Number] }], // per-question mapping of shown-index -> original-index
  createdAt: { type: Date, default: Date.now },
  expiresAt: Date,
  createdByIp: String,
}, { timestamps: true });

export default mongoose.models.ExamInstance || mongoose.model("ExamInstance", ExamInstanceSchema);
