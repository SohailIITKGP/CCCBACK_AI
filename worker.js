require("dotenv").config();

const connectDB = require("./config/db");
const { startOutboxPublisher } = require("./workers/outboxPublisher");
const { startOrchestratorWorker } = require("./workers/orchestratorWorker");
const { startSlaWorker } = require("./workers/slaWorker");
const { startFollowUpWorker } = require("./workers/followUpWorker");
const { startInboundPoller } = require("./services/inboundPoller");
const { isOrchestrationEnabled } = require("./config/orchestration");
const { seedCommunicationTemplates } = require("./services/templateService");
const { verifySmtpConnection } = require("./utils/smtpTransporter");

async function main() {
  if (!isOrchestrationEnabled()) {
    console.error(
      "[worker] AGENT_ORCHESTRATION_ENABLED is false or REDIS_URL is missing. Exiting."
    );
    process.exit(1);
  }

  await connectDB();
  console.log("[worker] MongoDB connected");

  await seedCommunicationTemplates();
  console.log("[worker] Communication templates seeded");

  await verifySmtpConnection();

  startOutboxPublisher();
  startOrchestratorWorker();
  startSlaWorker();
  startFollowUpWorker();
  startInboundPoller();

  console.log("[worker] Phase 1–3 orchestration workers running");
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("[worker] shutting down");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[worker] shutting down");
  process.exit(0);
});
