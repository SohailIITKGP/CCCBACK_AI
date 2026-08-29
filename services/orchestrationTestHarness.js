const OutboxEvent = require("../models/OutboxEvent");
const DomainEvent = require("../models/DomainEvent");
const { publishOutboxBatch } = require("./eventService");
const { processDomainEvent } = require("../workers/orchestratorWorker");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drainOutbox(maxRounds = 25) {
  let totalPublished = 0;
  for (let i = 0; i < maxRounds; i += 1) {
    const pendingBefore = await OutboxEvent.countDocuments({ status: "pending" });
    if (pendingBefore === 0) break;

    const result = await publishOutboxBatch();
    totalPublished += result.published;

    if (result.published === 0) {
      await sleep(200);
    }
  }
  return totalPublished;
}

/**
 * Process all domain events for a correlation ID in order (test / inline mode).
 * Loops: drain outbox → process unhandled events → repeat until stable.
 */
async function runInlineOrchestration(correlationId, maxIterations = 12) {
  for (let round = 0; round < maxIterations; round += 1) {
    await drainOutbox();

    const events = await DomainEvent.find({ correlationId })
      .sort({ "metadata.timestamp": 1, createdAt: 1 })
      .lean();

    let processedCount = 0;
    for (const event of events) {
      const result = await processDomainEvent(event);
      if (result.processed) processedCount += 1;
    }

    const pendingOutbox = await OutboxEvent.countDocuments({
      correlationId,
      status: "pending",
    });

    if (processedCount === 0 && pendingOutbox === 0) {
      return { rounds: round + 1, processedCount };
    }
  }

  return { rounds: maxIterations, exhausted: true };
}

module.exports = {
  drainOutbox,
  runInlineOrchestration,
  sleep,
};
