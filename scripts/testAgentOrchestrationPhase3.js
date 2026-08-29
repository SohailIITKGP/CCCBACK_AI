#!/usr/bin/env node
/**
 * Phase 3 test — deal orchestration (site visit proposal + approve).
 *
 *   node scripts/testAgentOrchestrationPhase3.js
 *   node scripts/testAgentOrchestrationPhase3.js --approve
 *   node scripts/testAgentOrchestrationPhase3.js --sla
 */

require("dotenv").config();

const connectDB = require("../config/db");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { seedCommunicationTemplates } = require("../services/templateService");
const leadFacade = require("../facades/leadFacade");
const linkFacade = require("../facades/linkFacade");
const {
  runInlineOrchestration,
  sleep,
} = require("../services/orchestrationTestHarness");
const dealExecutionService = require("../services/dealExecutionService");
const agentActionService = require("../services/agentActionService");
const slaMonitorHandler = require("../agents/handlers/slaMonitorHandler");

require("../models/User");
const User = require("../models/User");
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const Opportunity = require("../models/Opportunity");
const DomainEvent = require("../models/DomainEvent");
const AgentAction = require("../models/AgentAction");
const AgentLog = require("../models/AgentLog");
const FollowUpTask = require("../models/FollowUpTask");
const JourneyProcess = require("../models/JourneyProcess");
const OutboxEvent = require("../models/OutboxEvent");
const JourneyTimelineView = require("../models/JourneyTimelineView");
const ProcessedEvent = require("../models/ProcessedEvent");

const PASS = "PASS";
const FAIL = "FAIL";
const results = [];

const opts = {
  approve: process.argv.includes("--approve"),
  sla: process.argv.includes("--sla"),
  keep: process.argv.includes("--keep"),
};

const log = (...p) => console.log("[phase3-test]", ...p);
const record = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function findActor() {
  return (
    (await User.findOne({ role: "Super Admin", status: "Active" })) ||
    (await User.findOne({ role: "Manager", status: "Active" }))
  );
}

async function setupOpportunity(actor, assignee, stamp) {
  const property = await Property.create({
    name: `Phase3 Warehouse ${stamp}`,
    city: "Mumbai",
    roadName: "Andheri",
    exactArea: "5000",
    expectedRent: "520000",
    category: "warehouse",
    propertyStatus: "approved",
    isVisibility: true,
    whoCreated: actor._id,
  });

  const lead = await leadFacade.createLead(
    {
      name: `Phase3 Client ${stamp}`,
      contactNumber: `7777${String(stamp).slice(-6)}`,
      email: `phase3-${stamp}@example.com`,
      state: "Maharashtra",
      priority: "Hot",
      remarks: "warehouse Andheri phase3",
    },
    { type: "user", userId: actor._id }
  );

  const { client, correlationId } = await leadFacade.convertLeadToClient(
    lead._id,
    { priority: "Hot", assignedTo: assignee._id },
    { type: "user", userId: actor._id }
  );

  await Client.findByIdAndUpdate(client._id, {
    city: "Mumbai",
    preferredArea: "Andheri",
    expectedRent: "500000",
    minimumArea: "4000",
    requirement: "warehouse",
  });

  const linkResult = await linkFacade.linkPropertyToClient({
    clientId: client._id,
    propertyId: property._id,
    userId: actor._id,
    actorMeta: { correlationId: lead.correlationId || client.correlationId },
    skipNotifications: true,
  });

  if (linkResult.error) {
    throw new Error(`Link failed: ${linkResult.error} ${linkResult.message || ""}`);
  }

  await runInlineOrchestration(correlationId, 8);

  const opportunity =
    linkResult.opportunity ||
    (await Opportunity.findOne({ client: client._id, property: property._id }));

  const updatedClient = await Client.findById(client._id);
  return { lead, client: updatedClient, property, opportunity, correlationId };
}

async function assertPhase3(correlationId, opportunityId) {
  log("\nPhase 3 — Deal orchestration");

  const proposed = await DomainEvent.findOne({
    correlationId,
    eventType: "deal.site_visit_proposed",
  }).lean();
  record("DomainEvent deal.site_visit_proposed", Boolean(proposed));

  const action = await AgentAction.findOne({
    correlationId,
    intent: "propose_site_visit",
    status: "pending_approval",
  }).lean();
  record("AgentAction propose_site_visit", Boolean(action), action?._id?.toString());

  const agentLog = await AgentLog.findOne({
    correlationId,
    agentName: "DealOrchestratorAgent",
  }).lean();
  record("AgentLog DealOrchestratorAgent", Boolean(agentLog));

  const journey = await JourneyProcess.findOne({ correlationId }).lean();
  record(
    "JourneyProcess phase DEAL",
    journey?.currentPhase === "DEAL",
    journey?.currentPhase
  );

  return action;
}

async function cleanup(bundle) {
  const { correlationId, lead, client, property, opportunity } = bundle;
  if (correlationId) {
    const eventIds = (
      await DomainEvent.find({ correlationId }).select("eventId").lean()
    ).map((e) => e.eventId);
    await AgentAction.deleteMany({ correlationId });
    await AgentLog.deleteMany({ correlationId });
    await FollowUpTask.deleteMany({ opportunity: bundle.opportunity?._id });
    await JourneyTimelineView.deleteMany({ correlationId });
    await JourneyProcess.deleteMany({ correlationId });
    await DomainEvent.deleteMany({ correlationId });
    await OutboxEvent.deleteMany({ correlationId });
    if (eventIds.length) await ProcessedEvent.deleteMany({ eventId: { $in: eventIds } });
  }
  if (client?._id) {
    await Opportunity.deleteMany({ client: client._id });
    await Client.deleteOne({ _id: client._id });
  }
  if (lead?._id) await Lead.deleteOne({ _id: lead._id });
  if (property?._id) await Property.deleteOne({ _id: property._id });
  record("Cleanup", true);
}

(async () => {
  if (!isOrchestrationEnabled()) {
    console.error("Orchestration disabled.");
    process.exit(1);
  }

  await connectDB();
  await seedCommunicationTemplates();

  const actor = await findActor();
  const assignee =
    (await User.findOne({ role: "Lead-Employee", status: "Active" })) || actor;
  if (!actor) process.exit(1);

  const stamp = Date.now();
  log(`Actor: ${actor.email}`);

  const bundle = await setupOpportunity(actor, assignee, stamp);
  if (!bundle.opportunity) {
    console.error("Failed to create opportunity");
    process.exit(1);
  }
  log(`Opportunity ${bundle.opportunity._id} correlationId=${bundle.correlationId}`);

  const action = await assertPhase3(bundle.correlationId, bundle.opportunity._id);

  if (opts.approve && action) {
    log("\nApproving site visit...");
    const doc = await agentActionService.getById(action._id);
    const exec = await dealExecutionService.executeApprovedDealAction(doc, actor._id);
    if (exec.error) {
      record("Approve site visit", false, exec.error);
    } else {
      record("Approve site visit", true, exec.status);
      const opp = await Opportunity.findById(bundle.opportunity._id).lean();
      record(
        "Opportunity status updated",
        opp?.status === "Planning for Site Visit",
        opp?.status
      );
      const task = await FollowUpTask.findOne({
        opportunity: bundle.opportunity._id,
        taskType: "site_visit",
      }).lean();
      record("FollowUpTask site_visit created", Boolean(task));
    }
  }

  if (opts.sla) {
    log("\nSLA breach test...");
    const slaLead = await leadFacade.createLead(
      {
        name: `SLA Test ${stamp}`,
        contactNumber: `6666${String(stamp).slice(-6)}`,
        email: `sla-${stamp}@example.com`,
        priority: "Hot",
      },
      { type: "user", userId: actor._id }
    );
    await Lead.findByIdAndUpdate(slaLead._id, {
      createdAt: new Date(Date.now() - 48 * 3600 * 1000),
    });
    const fakeEvent = {
      eventId: "sla-test",
      eventType: "lead.qualified",
      aggregateId: slaLead._id,
      payload: { leadId: slaLead._id.toString() },
      correlationId: slaLead.correlationId,
    };
    await slaMonitorHandler.checkLeadContactSla(fakeEvent);
    const breach = await OutboxEvent.findOne({
      correlationId: slaLead.correlationId,
      eventType: "sla.breached",
    }).lean();
    record("sla.breached outbox event", Boolean(breach));
    if (!opts.keep) {
      await Lead.deleteOne({ _id: slaLead._id });
      await OutboxEvent.deleteMany({ correlationId: slaLead.correlationId });
    }
  }

  if (!opts.keep) {
    log("\nCleaning up...");
    await cleanup(bundle);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n========================================`);
  console.log(`Results: ${results.length - failed}/${results.length} passed`);
  console.log(`========================================`);
  if (failed) process.exitCode = 1;
  await require("mongoose").disconnect();
  await require("../queues/connection").closeRedisConnection();
  process.exit(process.exitCode || 0);
})().catch(async (e) => {
  console.error(e);
  try {
    await require("../queues/connection").closeRedisConnection();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
