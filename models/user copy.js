// models/User.js
import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, index: true },
  displayName: String,
  firstName: String,
  lastName: String,
  email: { type: String, index: true },
  photo: String,
  locale: String,
  provider: String,
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now }
}, { strict: true });

const User = mongoose.models.User || mongoose.model("User", UserSchema);
export default User;
