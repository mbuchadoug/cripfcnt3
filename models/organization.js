// models/organization.js
import mongoose from "mongoose";

const OrganizationSchema = new mongoose.Schema({
  name: { type: String, required: true, index: true },
  slug: { type: String, required: true, unique: true, index: true },
  description: String,
  createdAt: { type: Date, default: Date.now },
  // invite tokens (simple implementation); in production you'd separate to invites collection
  invites: [{
    token: String,
    role: { type: String, enum: ["employee", "manager", "admin"], default: "employee" },
    createdAt: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  }]
}, { timestamps: true });

export default mongoose.models.Organization || mongoose.model("Organization", OrganizationSchema);
