// models/orgMembership.js
import mongoose from "mongoose";

const OrgMembershipSchema = new mongoose.Schema({
  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
  role: { type: String, enum: ["employee", "manager", "admin"], default: "employee" },
  joinedAt: { type: Date, default: () => new Date() }
});

OrgMembershipSchema.index({ org: 1, user: 1 }, { unique: true });

export default mongoose.models.OrgMembership || mongoose.model("OrgMembership", OrgMembershipSchema);
