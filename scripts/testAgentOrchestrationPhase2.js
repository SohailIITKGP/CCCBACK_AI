#!/usr/bin/env node
/**
 * Phase 2 orchestration test — property matching + HITL link.
 *
 * Usage:
 *   node scripts/testAgentOrchestrationPhase2.js              # inline (stop worker first)
 *   node scripts/testAgentOrchestrationPhase2.js --wait-worker
 *   node scripts/testAgentOrchestrationPhase2.js --approve    # approve top match
 *   node scripts/testAgentOrchestrationPhase2.js --reject     # reject suggestion (2nd client)
 *   node scripts/testAgentOrchestrationPhase2.js --keep       # skip cleanup
 */

require("dotenv").config();

const connectDB = require("../config/db");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { seedCommunicationTemplates } = require("../services/templateService");
const leadFacade = require("../facades/leadFacade");
const { emitRequirementsUpdated } = require("../facades/clientFacade");
const {
  drainOutbox,
  runInlineOrchestration,
  sleep,
} = require("../services/orchestrationTestHarness");
const propertyMatchingExecutionService = require("../services/propertyMatchingExecutionService");
const propertyMatchingService = require("../services/propertyMatchingService");
const agentActionService = require("../services/agentActionService");

require("../models/User");
const User = require("../models/User");
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const Opportunity = require("../models/Opportunity");
const OutboxEvent = require("../models/OutboxEvent");
const DomainEvent = require("../models/DomainEvent");
const AgentAction = require("../models/AgentAction");
const AgentLog = require("../models/AgentLog");
const JourneyTimelineView = require("../models/JourneyTimelineView");
const JourneyProcess = require("../models/JourneyProcess");
const ProcessedEvent = require("../models/ProcessedEvent");

const PASS = "PASS";
const FAIL = "FAIL";
const WARN = "WARN";
const results = [];

const parseArgs = () => ({
  inline: !process.argv.includes("--wait-worker"),
  approve: process.argv.includes("--approve"),
  reject: process.argv.includes("--reject"),
  keep: process.argv.includes("--keep"),
  help: process.argv.includes("--help") || process.argv.includes("-h"),
});

const log = (...parts) => console.log("[phase2-test]", ...parts);

const record = (name, status, detail = "") => {
  results.push({ name, status, detail });
  const icon = status === PASS ? "✓" : status === WARN ? "!" : "✗";
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function findActorUser() {
  return (
    (await User.findOne({ role: "Super Admin", status: "Active" }).select("_id email role")) ||
    (await User.findOne({ role: "Manager", status: "Active" }).select("_id email role"))
  );
}

async function findAssignee() {
  return (
    (await User.findOne({ role: "Lead-Employee", status: "Active" }).select("_id")) ||
    (await User.findOne({ role: { $in: ["Lead-Employee", "Manager", "Super Admin"] } }).select("_id"))
  );
}

async function createMatchingProperty(actor, stamp) {
  return Property.create({
    name: `Phase2 Test Warehouse ${stamp}`,
    city: "Mumbai",
    roadName: "Andheri",
    exactArea: "5000",
    expectedRent: "520000",
    category: "warehouse",
    address: "Andheri East Industrial Area",
    propertyStatus: "approved",
    isVisibility: true,
    isArchive: false,
    whoCreated: actor._id,
  });
}

async function createLeadAndClient(actor, assignee, stamp, suffix) {
  const lead = await leadFacade.createLead(
    {
      name: `Phase2 Test Client ${suffix} ${stamp}`,
      contactPerson: "Test User",
      contactNumber: `8888${String(stamp).slice(-6)}`,
      email: `phase2-test-${suffix}-${stamp}@example.com`,
      state: "Maharashtra",
      sourceOfConnection: "Referral",
      remarks: `Urgent warehouse 5000 sqft Andheri phase2 ${suffix}`,
      priority: "Hot",
    },
    { type: "user", userId: actor._id },
    { ipAddress: "127.0.0.1" }
  );

  const { client, correlationId } = await leadFacade.convertLeadToClient(
    lead._id,
    { priority: "Hot", assignedTo: assignee._id },
    { type: "user", userId: actor._id },
    { ipAddress: "127.0.0.1" }
  );

  await Client.findByIdAndUpdate(client._id, {
    city: "Mumbai",
    preferredArea: "Andheri",
    expectedRent: "500000",
    minimumArea: "4000",
    requirement: "warehouse 4000-6000",
    kindOfBusiness: "warehouse",
  });

  const updatedClient = await Client.findById(client._id);
  await emitRequirementsUpdated(updatedClient, { type: "user", userId: actor._id });

  return { lead, client: updatedClient, correlationId };
}

async function pollUntilPhase2(correlationId, clientId, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const matched = await DomainEvent.exists({ correlationId, eventType: "property.matched" });
    const action = await AgentAction.exists({
      correlationId,
      intent: "suggest_properties",
      status: "pending_approval",
    });
    if (matched && action) return true;
    await sleep(1500);
  }
  return false;
}

async function assertPhase2(correlationId, clientId) {
  log("\nPhase 2 — Property matching + HITL");

  const matchResult = await propertyMatchingService.matchPropertiesForClient(clientId);
  if ((matchResult.matches || []).length >= 1) {
    record("Rule-based matching returns results", PASS, `${matchResult.matches.length} matches`);
  } else {
    record("Rule-based matching returns results", FAIL, `candidates=${matchResult.candidateCount}`);
  }

  const matchedEvent = await DomainEvent.findOne({ correlationId, eventType: "property.matched" }).lean();
  if (matchedEvent) {
    record("DomainEvent property.matched", PASS);
  } else {
    record("DomainEvent property.matched", FAIL);
  }

  const pendingAction = await AgentAction.findOne({
    correlationId,
    intent: "suggest_properties",
    status: "pending_approval",
  }).lean();

  if (pendingAction?.payload?.suggestions?.length >= 1) {
    record("AgentAction suggest_properties", PASS, `${pendingAction.payload.suggestions.length} suggestions`);
  } else {
    record("AgentAction suggest_properties", FAIL);
  }

  const agentLog = await AgentLog.findOne({
    correlationId,
    agentName: "PropertyMatchingAgent",
  }).lean();
  if (agentLog) {
    record("AgentLog PropertyMatchingAgent", PASS);
  } else {
    record("AgentLog PropertyMatchingAgent", FAIL);
  }

  return pendingAction;
}

async function assertAfterApprove(correlationId, clientId, propertyId) {
  const linked = await DomainEvent.findOne({ correlationId, eventType: "property.linked" }).lean();
  if (linked) record("DomainEvent property.linked", PASS);
  else record("DomainEvent property.linked", FAIL);

  const oppEvent = await DomainEvent.findOne({ correlationId, eventType: "opportunity.created" }).lean();
  if (oppEvent) record("DomainEvent opportunity.created", PASS);
  else record("DomainEvent opportunity.created", FAIL);

  const opp = await Opportunity.findOne({ client: clientId, property: propertyId }).lean();
  if (opp) record("Opportunity in DB", PASS, opp._id.toString());
  else record("Opportunity in DB", FAIL);
}

async function cleanup(ids) {
  for (const { correlationId, leadId, clientId, propertyId } of ids) {
    if (correlationId) {
      const eventIds = (
        await DomainEvent.find({ correlationId }).select("eventId").lean()
      ).map((e) => e.eventId);
      await AgentAction.deleteMany({ correlationId });
      await AgentLog.deleteMany({ correlationId });
      await JourneyTimelineView.deleteMany({ correlationId });
      await JourneyProcess.deleteMany({ correlationId });
      await DomainEvent.deleteMany({ correlationId });
      await OutboxEvent.deleteMany({ correlationId });
      if (eventIds.length) await ProcessedEvent.deleteMany({ eventId: { $in: eventIds } });
    }
    if (clientId) {
      await Opportunity.deleteMany({ client: clientId });
      await Client.deleteOne({ _id: clientId });
    }
    if (leadId) await Lead.deleteOne({ _id: leadId });
    if (propertyId) await Property.deleteOne({ _id: propertyId });
  }
  record("Cleanup test data", PASS);
}

function printSummary() {
  const passed = results.filter((r) => r.status === PASS).length;
  const failed = results.filter((r) => r.status === FAIL).length;
  console.log("\n========================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("========================================");
  if (failed > 0) {
    results.filter((r) => r.status === FAIL).forEach((r) => {
      console.log(`  - ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
    });
    process.exitCode = 1;
  }
}

(async () => {
  const opts = parseArgs();
  if (opts.help) {
    console.log(`
Phase 2 test — property matching + approve link

  node scripts/testAgentOrchestrationPhase2.js [--wait-worker] [--approve] [--reject] [--keep]
`);
    process.exit(0);
  }

  if (!isOrchestrationEnabled()) {
    console.error("AGENT_ORCHESTRATION_ENABLED is false or REDIS_URL missing.");
    process.exit(1);
  }

  log(`Mode: ${opts.inline ? "inline" : "wait-worker"}`);
  await connectDB();
  await seedCommunicationTemplates();

  const actor = await findActorUser();
  const assignee = await findAssignee();
  if (!actor || !assignee) {
    console.error("Need Super Admin/Manager and an assignee user.");
    process.exit(1);
  }
  log(`Actor: ${actor.email}`);

  const stamp = Date.now();
  const property = await createMatchingProperty(actor, stamp);
  log(`Created matching property ${property._id}`);

  const main = await createLeadAndClient(actor, assignee, stamp, "main");
  log(`Created client ${main.client._id} correlationId=${main.correlationId}`);

  const cleanupIds = [
    {
      correlationId: main.correlationId,
      leadId: main.lead._id,
      clientId: main.client._id,
      propertyId: property._id,
    },
  ];

  if (opts.inline) {
    log("Running inline orchestration (stop npm run worker first)...");
    await runInlineOrchestration(main.correlationId);
    record("Inline pipeline completed", PASS);
  } else {
    log("Waiting for worker...");
    const ok = await pollUntilPhase2(main.correlationId, main.client._id);
    record("Worker processed Phase 2", ok ? PASS : FAIL, ok ? "" : "timeout");
  }

  const pendingAction = await assertPhase2(main.correlationId, main.client._id);

  if (opts.approve && pendingAction) {
    log("\nApproving top property match...");
    const actionDoc = await agentActionService.getById(pendingAction._id);
    const exec = await propertyMatchingExecutionService.executeApprovedSuggestion(
      actionDoc,
      actor._id
    );
    if (exec.error) {
      record("Approve top match", FAIL, exec.error);
    } else {
      record("Approve top match", PASS, exec.propertyId);
      await drainOutbox();
      await runInlineOrchestration(main.correlationId, 4);
      await assertAfterApprove(main.correlationId, main.client._id, exec.propertyId);
    }
  }

  if (opts.reject) {
    log("\nReject flow — second client...");
    const second = await createLeadAndClient(actor, assignee, stamp + 1, "reject");
    cleanupIds.push({
      correlationId: second.correlationId,
      leadId: second.lead._id,
      clientId: second.client._id,
      propertyId: null,
    });
    if (opts.inline) await runInlineOrchestration(second.correlationId);
    else await pollUntilPhase2(second.correlationId, second.client._id);

    const action = await AgentAction.findOne({
      correlationId: second.correlationId,
      intent: "suggest_properties",
      status: "pending_approval",
    });
    if (action) {
      await agentActionService.reject(action._id, actor._id, "Phase2 test reject");
      const stillLinked = await Opportunity.exists({ client: second.client._id });
      record("Reject — no opportunity created", stillLinked ? FAIL : PASS);
    } else {
      record("Reject — pending action exists", FAIL);
    }
  }

  if (!opts.keep) {
    log("\nCleaning up...");
    await cleanup(cleanupIds);
  }

  printSummary();
  await require("mongoose").disconnect();
  await require("../queues/connection").closeRedisConnection();
  process.exit(process.exitCode || 0);
})().catch(async (err) => {
  console.error("[phase2-test] fatal:", err);
  try {
    await require("../queues/connection").closeRedisConnection();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
