import mongoose from "mongoose";
const CertificateSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  courseId: { type: mongoose.Schema.Types.ObjectId, ref: "Course" },
  issuedAt: Date,
  pdfPath: String,
  serial: { type: String, index: true }
}, { timestamps: true });
export default mongoose.models.Certificate || mongoose.model("Certificate", CertificateSchema);
