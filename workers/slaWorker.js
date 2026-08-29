const { Worker } = require("bullmq");
const { getRedisConnection } = require("../queues/connection");
const { SLA_QUEUE_NAME } = require("../queues/slaQueue");
const { runLeadContactSlaCheck } = require("../services/slaEngineService");

let workerInstance = null;

function startSlaWorker() {
  if (workerInstance) return workerInstance;

  workerInstance = new Worker(
    SLA_QUEUE_NAME,
    async (job) => {
      if (job.name !== "check-lead-contact") {
        return { skipped: true };
      }
      return runLeadContactSlaCheck(job.data || {});
    },
    {
      connection: getRedisConnection(),
      concurrency: 2,
    }
  );

  workerInstance.on("failed", (job, err) => {
    console.error(`[sla] job ${job?.id} failed:`, err.message);
  });

  console.log("[sla] worker started");
  return workerInstance;
}

module.exports = {
  startSlaWorker,
};
