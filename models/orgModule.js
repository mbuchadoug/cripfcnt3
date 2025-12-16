// models/orgModule.js
import mongoose from "mongoose";

const OrgModuleSchema = new mongoose.Schema({
  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", required: true },

  slug: { type: String, required: true },     // ✅ REQUIRED
  title: { type: String, required: true },
  description: { type: String },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("OrgModule", OrgModuleSchema);
