const mongoose = require("mongoose");

const insightReportSchema = new mongoose.Schema(
  {
    period: {
      type: String,
      enum: ["weekly", "monthly", "quarterly", "yearly"],
      required: true,
      index: true,
    },
    periodStart: { type: Date, required: true, index: true },
    periodEnd: { type: Date, required: true },
    scope: {
      type: String,
      enum: ["company"],
      default: "company",
      index: true,
    },
    document: { type: mongoose.Schema.Types.Mixed, required: true },
    generatedAt: { type: Date, default: Date.now, index: true },
    status: {
      type: String,
      enum: ["pending", "complete", "failed"],
      default: "complete",
    },
    generatedBy: {
      type: String,
      enum: ["cron", "manual", "api"],
      default: "api",
    },
    modelVersion: { type: String, default: "rule-only-v1" },
    errorMessage: { type: String, default: null },
    emailDigest: {
      sent: { type: Boolean, default: false },
      sentAt: { type: Date, default: null },
      recipientCount: { type: Number, default: 0 },
      error: { type: String, default: null },
    },
  },
  { timestamps: true }
);

insightReportSchema.index({ period: 1, periodEnd: -1, scope: 1 });
insightReportSchema.index({ period: 1, scope: 1, periodEnd: 1, generatedAt: -1 });

module.exports = mongoose.model("InsightReport", insightReportSchema);
