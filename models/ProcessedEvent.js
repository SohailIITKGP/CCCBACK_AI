const mongoose = require("mongoose");

const processedEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    workerName: { type: String, required: true, index: true },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

module.exports = mongoose.model("ProcessedEvent", processedEventSchema);
