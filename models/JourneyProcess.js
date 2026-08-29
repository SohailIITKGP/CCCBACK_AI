const mongoose = require("mongoose");

const journeyProcessSchema = new mongoose.Schema(
  {
    correlationId: { type: String, required: true, unique: true, index: true },
    processType: {
      type: String,
      enum: ["LEAD_TO_CLOSE"],
      default: "LEAD_TO_CLOSE",
    },
    currentPhase: {
      type: String,
      enum: ["ACQUIRE", "NURTURE", "MATCH", "DEAL", "CLOSE"],
      default: "ACQUIRE",
    },
    currentStep: { type: String, default: "lead_created" },
    status: {
      type: String,
      enum: ["ACTIVE", "PAUSED", "COMPLETED", "FAILED"],
      default: "ACTIVE",
    },
    context: {
      leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead" },
      clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client" },
      opportunityIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Opportunity" }],
      lastSuccessfulStep: { type: String, default: null },
      failedStep: { type: String, default: null },
    },
    pausedReason: {
      type: String,
      enum: [null, "waiting_client", "waiting_human", "dormant", "error"],
      default: null,
    },
    version: { type: Number, default: 1 },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("JourneyProcess", journeyProcessSchema);
