const { publishOutboxBatch } = require("../services/eventService");

const POLL_INTERVAL_MS = 2000;
let intervalHandle = null;

function startOutboxPublisher() {
  if (intervalHandle) {
    return intervalHandle;
  }

  const tick = async () => {
    try {
      const result = await publishOutboxBatch();
      if (result.published > 0 || result.failed > 0) {
        console.log(
          `[outbox] batch published=${result.published} failed=${result.failed}`
        );
      }
    } catch (err) {
      console.error("[outbox] publisher tick error:", err.message);
    }
  };

  tick();
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[outbox] publisher started (every ${POLL_INTERVAL_MS}ms)`);
  return intervalHandle;
}

function stopOutboxPublisher() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = {
  startOutboxPublisher,
  stopOutboxPublisher,
};
