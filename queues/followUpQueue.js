const { Queue } = require("bullmq");
const { getRedisConnection } = require("./connection");

const FOLLOW_UP_QUEUE_NAME = "lead-follow-up-sequence";

let followUpQueue = null;

function getFollowUpQueue() {
  if (!followUpQueue) {
    followUpQueue = new Queue(FOLLOW_UP_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    });
  }
  return followUpQueue;
}

function followUpJobId(leadId, stepIndex) {
  return `followup-${leadId}-step-${stepIndex}`;
}

module.exports = {
  FOLLOW_UP_QUEUE_NAME,
  getFollowUpQueue,
  followUpJobId,
};
