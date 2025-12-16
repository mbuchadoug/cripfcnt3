import mongoose from "mongoose";
const QuizSchema = new mongoose.Schema({
  lesson: { type: mongoose.Schema.Types.ObjectId, ref: "Lesson", index: true },
  title: String,
  description: String,
  timeLimitSeconds: { type: Number, default: 0 }, // 0 = no limit
  passingPercent: { type: Number, default: 70 },
  questions: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question" }]
}, { timestamps: true });
export default mongoose.models.Quiz || mongoose.model("Quiz", QuizSchema);
