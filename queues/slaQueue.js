const { Queue } = require("bullmq");
const { getRedisConnection } = require("./connection");

const SLA_QUEUE_NAME = "sla-checks";

let slaQueue = null;

function getSlaQueue() {
  if (!slaQueue) {
    slaQueue = new Queue(SLA_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 2,
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    });
  }
  return slaQueue;
}

module.exports = {
  SLA_QUEUE_NAME,
  getSlaQueue,
};
