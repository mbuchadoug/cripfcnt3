// models/examInstance.js
import mongoose from "mongoose";

const ExamInstanceSchema = new mongoose.Schema(
  {
    examId: { type: String, required: true, index: true, unique: true },

    title: { type: String, default: null },


    // Organization that owns this exam (nullable for platform/global)
    org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true, default: null },

    // Module key (e.g. "responsibility")
    module: { type: String, default: "general", index: true },

    // Assigned user (optional for generic attempts)
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },

    /**
     * questionIds intentionally uses Mixed so it can hold:
     *  - ObjectId (native child/regular question ids)
     *  - String ids (stringified ObjectId)
     *  - Marker strings like "parent:<parentId>"
     *
     * This keeps compatibility with the "parent:..." marker approach used
     * when you want to render a passage followed by child questions.
     */
    questionIds: { type: [mongoose.Schema.Types.Mixed], default: [] },

    /**
     * choicesOrder is an array where each entry corresponds to the question
     * position in questionIds. For parent markers you may have [] or null.
     * Use Mixed to avoid casting issues (arrays of numbers are typical).
     */
    choicesOrder: { type: [mongoose.Schema.Types.Mixed], default: [] },

    // optional expiry timestamp
    expiresAt: { type: Date, default: null },

    // status: pending/finished/expired etc.
    status: { type: String, default: "pending", index: true },

    // IP of creator for audit
    createdByIp: { type: String, default: null },

    // optional free-form metadata
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true, // createdAt & updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// convenience virtual for question count (counts only real child entries — but includes markers)
ExamInstanceSchema.virtual("questionCount").get(function () {
  if (!Array.isArray(this.questionIds)) return 0;
  return this.questionIds.length;
});

// add a small helper method to normalize questionIds to string array
ExamInstanceSchema.methods.normalizedQuestionIds = function () {
  return (this.questionIds || []).map((qid) => {
    if (!qid && qid !== 0) return qid;
    // if it's an ObjectId -> toString
    if (typeof qid === "object" && typeof qid.toString === "function") return qid.toString();
    return String(qid);
  });
};

// basic indexes that will help lookups
ExamInstanceSchema.index({ org: 1, user: 1, examId: 1 });

const ExamInstance = mongoose.models.ExamInstance || mongoose.model("ExamInstance", ExamInstanceSchema);
export default ExamInstance;
