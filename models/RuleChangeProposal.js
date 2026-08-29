const mongoose = require("mongoose");

const ruleChangeProposalSchema = new mongoose.Schema(
  {
    batchId: { type: String, required: true, index: true },
    ruleSet: {
      type: String,
      enum: ["matching", "follow_up", "lead_scoring"],
      required: true,
      index: true,
    },
    parameter: { type: String, required: true },
    currentValue: { type: mongoose.Schema.Types.Mixed, required: true },
    proposedValue: { type: mongoose.Schema.Types.Mixed, required: true },
    rationale: { type: String, required: true },
    evidence: {
      sampleSize: { type: Number, default: 0 },
      winRate: { type: Number, default: null },
      baselineWinRate: { type: Number, default: null },
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date, default: null },
    appliedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ruleChangeProposalSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("RuleChangeProposal", ruleChangeProposalSchema);
