// models/orgInvite.js
import mongoose from "mongoose";

const OrgInviteSchema = new mongoose.Schema({
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true, required: true },
  email: { type: String, required: true, index: true },
  token: { type: String, required: true, unique: true },
  role: { type: String, enum: ["employee", "manager"], default: "employee" },
  used: { type: Boolean, default: false },
  createdAt: { type: Date, default: () => new Date() }
});

export default mongoose.models.OrgInvite || mongoose.model("OrgInvite", OrgInviteSchema);
