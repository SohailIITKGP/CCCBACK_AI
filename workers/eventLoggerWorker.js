const { Worker } = require("bullmq");
const { getRedisConnection } = require("../queues/connection");
const { QUEUE_NAME } = require("../queues/eventQueue");
const AgentLog = require("../models/AgentLog");
const {
  isDuplicate,
  markProcessed,
  WORKER_EVENT_LOGGER,
} = require("../services/processedEventStore");

let workerInstance = null;

function startEventLoggerWorker() {
  if (workerInstance) {
    return workerInstance;
  }

  workerInstance = new Worker(
    QUEUE_NAME,
    async (job) => {
      const startMs = Date.now();
      const data = job.data || {};
      const eventId = data.eventId;

      if (!eventId) {
        throw new Error("Job missing eventId");
      }

      if (await isDuplicate(eventId, WORKER_EVENT_LOGGER)) {
        await AgentLog.create({
          correlationId: data.correlationId,
          eventId,
          eventType: data.eventType,
          workerName: WORKER_EVENT_LOGGER,
          message: `Skipped duplicate event: ${data.eventType}`,
          result: "skipped",
          durationMs: Date.now() - startMs,
        });
        return { skipped: true };
      }

      await AgentLog.create({
        correlationId: data.correlationId,
        eventId,
        eventType: data.eventType,
        workerName: WORKER_EVENT_LOGGER,
        message: `Event received: ${data.eventType}`,
        result: "success",
        durationMs: Date.now() - startMs,
        meta: {
          aggregateType: data.aggregateType,
          aggregateId: data.aggregateId,
        },
      });

      await markProcessed(eventId, WORKER_EVENT_LOGGER);
      return { processed: true };
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
    }
  );

  workerInstance.on("failed", (job, err) => {
    console.error(
      `[eventLogger] job ${job?.id} failed:`,
      err.message
    );
  });

  workerInstance.on("error", (err) => {
    console.error("[eventLogger] worker error:", err.message);
  });

  console.log("[eventLogger] worker started");
  return workerInstance;
}

async function stopEventLoggerWorker() {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
}

module.exports = {
  startEventLoggerWorker,
  stopEventLoggerWorker,
};
