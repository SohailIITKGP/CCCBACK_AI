const { Worker } = require("bullmq");
const { getRedisConnection } = require("../queues/connection");
const { FOLLOW_UP_QUEUE_NAME } = require("../queues/followUpQueue");
const { runScheduledStep } = require("../services/leadFollowUpSequenceService");
const { runProposalFollowUp } = require("../services/opportunityProposalFollowUpService");
const { runProposalStaleCheck } = require("../services/opportunityProposalStaleService");

let workerInstance = null;

function startFollowUpWorker() {
  if (workerInstance) return workerInstance;

  workerInstance = new Worker(
    FOLLOW_UP_QUEUE_NAME,
    async (job) => {
      if (job.name === "send-sequence-step") {
        return runScheduledStep(job.data || {});
      }
      if (job.name === "proposal-follow-up") {
        return runProposalFollowUp(job.data || {});
      }
      if (job.name === "proposal-stale-check") {
        return runProposalStaleCheck(job.data || {});
      }
      return { skipped: true, reason: "unknown_job" };
    },
    {
      connection: getRedisConnection(),
      concurrency: 2,
    }
  );

  workerInstance.on("failed", (job, err) => {
    console.error(`[follow-up] job ${job?.id} failed:`, err.message);
  });

  console.log("[follow-up] sequence worker started");
  return workerInstance;
}

module.exports = {
  startFollowUpWorker,
};
