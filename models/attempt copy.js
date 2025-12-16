import mongoose from "mongoose";
const AttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true },
  module: String,
  questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question" }], // questions served
  answers: [{ questionId: mongoose.Schema.Types.ObjectId, choiceIndex: Number }],
  score: Number,
  maxScore: Number,
  passed: Boolean,
  startedAt: Date,
  finishedAt: Date
}, { timestamps: true });
export default mongoose.models.Attempt || mongoose.model("Attempt", AttemptSchema);
