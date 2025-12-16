import mongoose from "mongoose";
const EnrollmentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: "Course", index: true },
  progress: { type: Number, default: 0 }, // percent
  completedLessons: [{ type: mongoose.Schema.Types.ObjectId, ref: "Lesson" }],
  startedAt: Date,
  completedAt: Date
}, { timestamps: true });
export default mongoose.models.Enrollment || mongoose.model("Enrollment", EnrollmentSchema);
