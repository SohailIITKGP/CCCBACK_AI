const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    token: {
      type: String,
      required: true,
      unique: true, // unique automatically creates an index
    },
    ipAddress: {
      type: String,
      required: true,
    },
    userAgent: {
      type: String,
      default: "",
    },
    deviceInfo: {
      type: String,
      default: "",
    },
    loginTime: {
      type: Date,
      default: Date.now,
      required: true,
    },
    lastActivity: {
      type: Date,
      default: Date.now,
    },
    logoutTime: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    logoutReason: {
      type: String,
      enum: ["manual", "auto_logout", "admin_logout", "session_expired", "forced"],
      default: null,
    },
    location: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// Index for efficient queries
sessionSchema.index({ userId: 1, isActive: 1 });
// Note: token index is already created by unique: true in schema definition
sessionSchema.index({ lastActivity: 1 });

// Method to check if session is expired (24 hours)
sessionSchema.methods.isExpired = function () {
  const maxSessionDuration = 24 * 60 * 60 * 1000; // 24 hours
  const now = new Date();
  return now - this.lastActivity > maxSessionDuration;
};

module.exports = mongoose.model("Session", sessionSchema);

