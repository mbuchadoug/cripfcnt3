// models/orgModule.js
import mongoose from "mongoose";

const OrgModuleSchema = new mongoose.Schema({
  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
  slug: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, default: "" },
  createdAt: { type: Date, default: () => new Date() }
});

OrgModuleSchema.index({ org: 1, slug: 1 }, { unique: true });

export default mongoose.models.OrgModule || mongoose.model("OrgModule", OrgModuleSchema);
