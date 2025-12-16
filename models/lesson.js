import mongoose from "mongoose";
const LessonSchema = new mongoose.Schema({
  module: { type: mongoose.Schema.Types.ObjectId, ref: "Module", index: true },
  title: String,
  body: String, // HTML/MD
  media: [{ type: String }], // image/video urls
  order: { type: Number, default: 0 },
  quiz: { type: mongoose.Schema.Types.ObjectId, ref: "Quiz", default: null }
}, { timestamps: true });
export default mongoose.models.Lesson || mongoose.model("Lesson", LessonSchema);
