const mongoose = require("mongoose");

const journeyTimelineViewSchema = new mongoose.Schema(
  {
    correlationId: { type: String, required: true, unique: true, index: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead" },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client" },
    currentPhase: { type: String, default: "ACQUIRE" },
    currentState: { type: String, default: "NEW" },
    timeline: [
      {
        eventId: String,
        eventType: String,
        summary: String,
        actor: String,
        channel: { type: String, default: "system" },
        timestamp: Date,
      },
    ],
    lastEventAt: { type: Date },
    aiActionCount: { type: Number, default: 0 },
    humanOverrideCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("JourneyTimelineView", journeyTimelineViewSchema);
