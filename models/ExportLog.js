const mongoose = require("mongoose");

const exportLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userEmail: { type: String, required: true },
    userRole: { type: String, required: true },
    exportType: {
      type: String,
      enum: ["clients", "properties", "leads", "opportunities", "reports"],
      required: true,
    },
    recordCount: { type: Number, required: true },
    fieldsExported: [{ type: String }], // Track which fields were exported
    filtersApplied: { type: Object }, // Store any filters used
    exportId: { type: String, unique: true }, // Unique identifier for this export
    ipAddress: { type: String },
    userAgent: { type: String },
    fileName: { type: String },
    fileHash: { type: String }, // For tracking file distribution
    suspiciousActivity: { type: Boolean, default: false },
    suspiciousReason: { type: String },
  },
  { timestamps: true }
);

// Index for efficient querying
exportLogSchema.index({ userId: 1, createdAt: -1 });
exportLogSchema.index({ exportType: 1, createdAt: -1 });
exportLogSchema.index({ suspiciousActivity: 1 });
exportLogSchema.index({ exportId: 1 });

module.exports = mongoose.model("ExportLog", exportLogSchema);

