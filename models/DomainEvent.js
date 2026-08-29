const mongoose = require("mongoose");

const domainEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true, index: true },
    aggregateType: { type: String, required: true, index: true },
    aggregateId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    correlationId: { type: String, required: true, index: true },
    causationId: { type: String, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    schemaVersion: { type: Number, default: 1 },
    metadata: {
      actor: { type: String, default: "system" },
      actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
      agentVersion: { type: String, default: null },
      timestamp: { type: Date, default: Date.now },
      ipAddress: { type: String, default: null },
    },
  },
  { timestamps: true }
);

domainEventSchema.index({ "metadata.timestamp": -1 });
domainEventSchema.index({ correlationId: 1, "metadata.timestamp": 1 });

module.exports = mongoose.model("DomainEvent", domainEventSchema);
