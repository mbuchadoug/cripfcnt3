// models/visit.js
import mongoose from "mongoose";

const VisitSchema = new mongoose.Schema({
  // YYYY-MM-DD string for daily bucket
  day: { type: String, index: true },     // e.g. "2025-11-19"
  // YYYY-MM string for monthly bucket (optional, set at write time)
  month: { type: String, index: true },   // e.g. "2025-11"
  year: { type: String, index: true },    // e.g. "2025"

  // optional path (if you want per-path stats)
  path: { type: String, index: true, default: "/" },

  // counts
  hits: { type: Number, default: 0 },

  // store sample info (first seen, last seen)
  firstSeenAt: Date,
  lastSeenAt: Date,
}, { timestamps: true });

VisitSchema.index({ day: 1, path: 1 }, { unique: true });

export default mongoose.models.Visit || mongoose.model("Visit", VisitSchema);
