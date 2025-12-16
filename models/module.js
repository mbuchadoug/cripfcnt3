// models/module.js
import mongoose from "mongoose";

const ModuleSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", index: true },
  title: { type: String, required: true },
  order: { type: Number, default: 0 },
  lessons: [{ type: mongoose.Schema.Types.ObjectId, ref: "Lesson" }]
}, { timestamps: true });

// Create or reuse model
const ModuleModel = mongoose.models.Module || mongoose.model("Module", ModuleSchema);

// Named export (helps CommonJS/ESM interop and circular import timing)
export { ModuleModel as Module };

// Default export (so `import Module from ".../module.js"` works)
export default ModuleModel;
