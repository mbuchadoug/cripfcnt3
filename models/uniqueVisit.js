// models/uniqueVisit.js
import mongoose from "mongoose";

const UniqueVisitSchema = new mongoose.Schema({
  day: { type: String, index: true },      // "2025-11-19"
  month: { type: String, index: true },    // "2025-11"
  year: { type: String, index: true },     // "2025"
  visitorId: { type: String, index: true },
  path: { type: String, index: true, default: "/" },
  firstSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Unique constraint to avoid duplicates
UniqueVisitSchema.index({ day: 1, visitorId: 1, path: 1 }, { unique: true });

export default mongoose.models.UniqueVisit || mongoose.model("UniqueVisit", UniqueVisitSchema);
