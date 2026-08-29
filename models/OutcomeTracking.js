const mongoose = require("mongoose");

const propertyShownSchema = new mongoose.Schema(
  {
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: "Property" },
    rank: { type: Number, default: null },
    accepted: { type: Boolean, default: false },
  },
  { _id: false }
);

const outcomeTrackingSchema = new mongoose.Schema(
  {
    correlationId: { type: String, required: true, index: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", index: true },
    opportunityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Opportunity",
      required: true,
      unique: true,
      index: true,
    },
    outcome: {
      type: String,
      enum: ["won", "lost", "abandoned"],
      required: true,
      index: true,
    },
    lossReason: { type: String, default: null },
    propertiesShown: [propertyShownSchema],
    followUpTemplatesUsed: [{ type: String }],
    leadSource: { type: String, default: null },
    daysToClose: { type: Number, default: null },
    humanOverrides: { type: Number, default: 0 },
    aiApprovalRate: { type: Number, default: null },
    closedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

outcomeTrackingSchema.index({ closedAt: -1, outcome: 1 });

module.exports = mongoose.model("OutcomeTracking", outcomeTrackingSchema);
