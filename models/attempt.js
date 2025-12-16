// models/attempt.js
import mongoose from "mongoose";

const AnswerSub = new mongoose.Schema({
  questionId: { type: mongoose.Schema.Types.Mixed, required: true }, // ObjectId or string (file fallback)
  choiceIndex: { type: Number, default: null },      // index as stored on the Question (original order)
  shownIndex: { type: Number, default: null },       // index user clicked in the UI (shown order)
  selectedText: { type: String, default: "" },       // choice text at time of submit
  correctIndex: { type: Number, default: null },     // correct index as known from Question (original order)
  correct: { type: Boolean, default: false }
}, { _id: false });

const AttemptSchema = new mongoose.Schema({
  examId: { type: String, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, default: null },
  organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true, default: null },
  module: { type: String, default: null },
  questionIds: [{ type: mongoose.Schema.Types.Mixed }], // preserve either ObjectId or fallback id strings
  answers: [AnswerSub],
  score: { type: Number, default: 0 },
  maxScore: { type: Number, default: 0 },
  passed: { type: Boolean, default: false },
  status: { type: String, default: "in_progress" }, // in_progress | finished
  startedAt: { type: Date },
  finishedAt: { type: Date }
}, { timestamps: true });

export default mongoose.models.Attempt || mongoose.model("Attempt", AttemptSchema);
