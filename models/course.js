import mongoose from "mongoose";

const CourseSchema = new mongoose.Schema({
  slug: { type: String, index: true, required: true, unique: true },
  title: { type: String, required: true },
  shortDescription: String,
  longDescription: String,
  heroImage: String, // path or url
  colorPalette: { gold: String, black: String, charcoal: String, white: String },
  sections: [{ type: mongoose.Schema.Types.ObjectId, ref: "Module" }],
  durationMinutes: Number,
  published: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
}, { timestamps: true });

export default mongoose.models.Course || mongoose.model("Course", CourseSchema);
