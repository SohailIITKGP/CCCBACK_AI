const ProcessedEvent = require("../models/ProcessedEvent");

const WORKER_EVENT_LOGGER = "event_logger";
const WORKER_ORCHESTRATOR = "orchestrator";

/** Idempotency is keyed by eventId only (unique index). */
async function isDuplicate(eventId) {
  const existing = await ProcessedEvent.findOne({ eventId }).lean();
  return Boolean(existing);
}

async function markProcessed(eventId, workerName = WORKER_ORCHESTRATOR) {
  try {
    await ProcessedEvent.updateOne(
      { eventId },
      { $setOnInsert: { eventId, workerName, processedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    if (err.code === 11000) return;
    throw err;
  }
}

module.exports = {
  WORKER_EVENT_LOGGER,
  WORKER_ORCHESTRATOR,
  isDuplicate,
  markProcessed,
};
