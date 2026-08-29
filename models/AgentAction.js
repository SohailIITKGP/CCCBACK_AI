const mongoose = require("mongoose");

const agentActionSchema = new mongoose.Schema(
  {
    agentName: { type: String, required: true, index: true },
    agentVersion: { type: String, default: "1.0.0" },
    intent: { type: String, required: true, index: true },
    entityType: { type: String, required: true, index: true },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    correlationId: { type: String, required: true, index: true },
    triggerEventId: { type: String, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    confidence: { type: Number, default: null },
    reasoning: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending_approval", "approved", "rejected", "executed", "failed"],
      default: "pending_approval",
      index: true,
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rejectionReason: { type: String, default: null },
    executedAt: { type: Date, default: null },
    executionResult: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

agentActionSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("AgentAction", agentActionSchema);
