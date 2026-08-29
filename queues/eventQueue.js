const { Queue } = require("bullmq");
const { getRedisConnection } = require("./connection");

const QUEUE_NAME = "domain-events";

let eventQueue = null;

function getEventQueue() {
  if (!eventQueue) {
    eventQueue = new Queue(QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return eventQueue;
}

module.exports = {
  QUEUE_NAME,
  getEventQueue,
};
