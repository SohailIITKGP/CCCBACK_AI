const { Worker } = require("bullmq");
const { getRedisConnection } = require("../queues/connection");
const { QUEUE_NAME } = require("../queues/eventQueue");
const DomainEvent = require("../models/DomainEvent");
const AgentLog = require("../models/AgentLog");
const {
  isDuplicate,
  markProcessed,
  WORKER_ORCHESTRATOR,
} = require("../services/processedEventStore");
const journeyProjectionService = require("../services/journeyProjectionService");
const processManagerService = require("../services/processManagerService");
const leadQualificationHandler = require("../agents/handlers/leadQualificationHandler");
const followUpSchedulerHandler = require("../agents/handlers/followUpSchedulerHandler");
const propertyMatchingHandler = require("../agents/handlers/propertyMatchingHandler");
const dealOrchestratorHandler = require("../agents/handlers/dealOrchestratorHandler");
const proposalOrchestratorHandler = require("../agents/handlers/proposalOrchestratorHandler");
const slaMonitorHandler = require("../agents/handlers/slaMonitorHandler");
const responseAgentHandler = require("../agents/handlers/responseAgentHandler");
const propertyChangeHandler = require("../agents/handlers/propertyChangeHandler");
const propertyLifecycleHandler = require("../agents/handlers/propertyLifecycleHandler");

let workerInstance = null;

async function routeEvent(event) {
  switch (event.eventType) {
    case "lead.created":
      await leadQualificationHandler.handleLeadCreated(event);
      break;
    case "lead.qualified":
      await followUpSchedulerHandler.handleLeadQualified(event);
      break;
    case "lead.converted":
      if (event.payload?.clientId) {
        await processManagerService.onLeadConverted(
          event.correlationId,
          event.payload.clientId
        );
      }
      break;
    case "client.created":
    case "client.requirements_updated":
      await propertyMatchingHandler.handleClientMatchingEvent(event);
      break;
    case "employee.activity_logged":
      if (event.payload?.clientId && event.payload?.updates) {
        await propertyMatchingHandler.handleClientMatchingEvent({
          ...event,
          eventType: "client.requirements_updated",
          payload: {
            ...event.payload,
            clientId: event.payload.clientId,
          },
        });
      }
      break;
    case "opportunity.created":
      await proposalOrchestratorHandler.handleOpportunityCreated(event);
      await dealOrchestratorHandler.handleOpportunityCreated(event);
      break;
    case "proposal.viewed":
    case "proposal.follow_up_sent":
      await dealOrchestratorHandler.handleProposalEngagementReady(event);
      break;
    case "sla.breached":
      await slaMonitorHandler.handleSlaBreached(event);
      break;
    case "message.replied":
      await responseAgentHandler.handleMessageReplied(event);
      break;
    case "property.override_linked":
      await propertyChangeHandler.handlePropertyOverrideLinked(event);
      break;
    case "property.unlinked":
      await propertyChangeHandler.handlePropertyUnlinked(event);
      break;
    case "proposal.superseded":
      await propertyChangeHandler.handleProposalSuperseded(event);
      break;
    case "property.unavailable":
      await propertyLifecycleHandler.handlePropertyUnavailable(event);
      break;
    case "property.price_changed":
      await propertyLifecycleHandler.handlePropertyPriceChanged(event);
      break;
    case "property.deleted":
      await propertyLifecycleHandler.handlePropertyDeleted(event);
      break;
    default:
      break;
  }
}

async function processDomainEvent(domainEvent) {
  const startMs = Date.now();
  const eventId = domainEvent.eventId;

  if (await isDuplicate(eventId)) {
    return { skipped: true, reason: "duplicate" };
  }

  await AgentLog.create({
    correlationId: domainEvent.correlationId,
    eventId,
    eventType: domainEvent.eventType,
    workerName: WORKER_ORCHESTRATOR,
    message: `Event received: ${domainEvent.eventType}`,
    result: "success",
    durationMs: Date.now() - startMs,
    meta: {
      aggregateType: domainEvent.aggregateType,
      aggregateId: domainEvent.aggregateId,
    },
  });

  await journeyProjectionService.upsertFromDomainEvent(domainEvent);

  try {
    await routeEvent(domainEvent);
  } catch (err) {
    await AgentLog.create({
      correlationId: domainEvent.correlationId,
      eventId,
      eventType: domainEvent.eventType,
      workerName: WORKER_ORCHESTRATOR,
      agentName: "Orchestrator",
      message: `Agent routing failed: ${err.message}`,
      result: "failed",
      errorMessage: err.message,
    });
    throw err;
  }

  await markProcessed(eventId, WORKER_ORCHESTRATOR);
  return { processed: true };
}

function startOrchestratorWorker() {
  if (workerInstance) {
    return workerInstance;
  }

  workerInstance = new Worker(
    QUEUE_NAME,
    async (job) => {
      const data = job.data || {};
      const eventId = data.eventId;

      if (!eventId) {
        throw new Error("Job missing eventId");
      }

      if (await isDuplicate(eventId)) {
        return { skipped: true, reason: "duplicate" };
      }

      const domainEvent =
        (await DomainEvent.findOne({ eventId }).lean()) ||
        ({
          eventId: data.eventId,
          eventType: data.eventType,
          aggregateType: data.aggregateType,
          aggregateId: data.aggregateId,
          correlationId: data.correlationId,
          payload: data.payload,
          metadata: data.metadata || {},
        });

      return processDomainEvent(domainEvent);
    },
    {
      connection: getRedisConnection(),
      concurrency: 3,
    }
  );

  workerInstance.on("failed", (job, err) => {
    console.error(`[orchestrator] job ${job?.id} failed:`, err.message);
  });

  workerInstance.on("error", (err) => {
    console.error("[orchestrator] worker error:", err.message);
  });

  console.log("[orchestrator] worker started");
  return workerInstance;
}

async function stopOrchestratorWorker() {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
}

module.exports = {
  startOrchestratorWorker,
  stopOrchestratorWorker,
  processDomainEvent,
  routeEvent,
};
