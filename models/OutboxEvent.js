const mongoose = require("mongoose");

const outboxEventSchema = new mongoose.Schema(
  {
    outboxId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true, index: true },
    aggregateType: { type: String, required: true },
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
      ipAddress: { type: String, default: null },
    },
    status: {
      type: String,
      enum: ["pending", "published", "failed"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

outboxEventSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model("OutboxEvent", outboxEventSchema);
