const mongoose = require("mongoose");

const agentLogSchema = new mongoose.Schema(
  {
    traceId: { type: String, default: null, index: true },
    correlationId: { type: String, index: true },
    eventId: { type: String, index: true },
    eventType: { type: String, index: true },
    workerName: { type: String, required: true, index: true },
    agentName: { type: String, default: null },
    agentVersion: { type: String, default: null },
    decision: { type: String, default: null },
    message: { type: String, required: true },
    result: {
      type: String,
      enum: ["success", "failed", "skipped"],
      default: "success",
    },
    durationMs: { type: Number, default: null },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

agentLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AgentLog", agentLogSchema);
