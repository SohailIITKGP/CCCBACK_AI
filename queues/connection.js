const IORedis = require("ioredis");

let sharedConnection = null;

/**
 * Parse Redis connection options for BullMQ / ioredis.
 *
 * TLS is enabled ONLY when:
 *   - URL scheme is rediss://, OR
 *   - REDIS_TLS=true is set explicitly
 *
 * Do NOT auto-enable TLS for redis:// URLs — that causes:
 *   ssl3_get_record:wrong version number
 */
function buildRedisOptions() {
  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const explicitTls = process.env.REDIS_TLS === "true";
  const useTls = url.startsWith("rediss://") || explicitTls;

  const options = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy(times) {
      if (times > 20) return null;
      return Math.min(times * 200, 5000);
    },
  };

  if (useTls) {
    options.tls = {};
  }

  return { url, options };
}

function createRedisConnection() {
  const { url, options } = buildRedisOptions();
  const client = new IORedis(url, options);

  client.on("error", (err) => {
    console.error("[redis] connection error:", err.message);
  });

  client.on("connect", () => {
    console.log("[redis] connected");
  });

  return client;
}

function getRedisConnection() {
  if (!sharedConnection) {
    sharedConnection = createRedisConnection();
  }
  return sharedConnection;
}

async function closeRedisConnection() {
  if (!sharedConnection) return;
  const conn = sharedConnection;
  sharedConnection = null;
  try {
    await conn.quit();
  } catch (_) {
    conn.disconnect();
  }
}

module.exports = {
  buildRedisOptions,
  createRedisConnection,
  getRedisConnection,
  closeRedisConnection,
};
