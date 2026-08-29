#!/usr/bin/env node
/**
 * End-to-end test: link → opportunity → proposal email → proposal viewed → site visit → AI paused
 *
 *   node scripts/testProposalDealFlow.js
 *   node scripts/testProposalDealFlow.js --keep
 */

require("dotenv").config();

const connectDB = require("../config/db");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { seedCommunicationTemplates } = require("../services/templateService");
const { updateAutomationSettings, getAutomationSettings } = require("../services/agentAutomationService");
const leadFacade = require("../facades/leadFacade");
const linkFacade = require("../facades/linkFacade");
const {
  runInlineOrchestration,
  drainOutbox,
} = require("../services/orchestrationTestHarness");
const { processDomainEvent } = require("../workers/orchestratorWorker");
const dealExecutionService = require("../services/dealExecutionService");
const agentActionService = require("../services/agentActionService");
const { enqueueOutboxEvent } = require("../services/outboxService");
const { getFollowUpQueue } = require("../queues/followUpQueue");
const {
  proposalFollowUpJobId,
} = require("../services/opportunityProposalFollowUpService");
const { isAiPaused } = require("../services/aiPauseService");
const { buildProposalPublicUrl } = require("../config/opportunityDealFlow");

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
const ProposalVisit = require("../models/ProposalVisit");

const opts = { keep: process.argv.includes("--keep") };
const results = [];

const log = (...p) => console.log("[proposal-flow-test]", ...p);
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function findActor() {
  return (
    (await User.findOne({ role: "Super Admin", status: "Active" })) ||
    (await User.findOne({ role: "Manager", status: "Active" }))
  );
}

async function findSeedProperty() {
  return Property.findOne({
    name: /Surat Varachha Office/i,
    propertyStatus: "approved",
    isVisibility: true,
  }).lean();
}

async function setupLinkedOpportunity(actor, assignee, stamp) {
  let property = await findSeedProperty();
  if (!property) {
    property = await Property.create({
      name: `Proposal Flow Test Office ${stamp}`,
      city: "Surat",
      roadName: "Varachha",
      exactArea: "1200",
      expectedRent: "450000",
      category: "office",
      address: "Varachha Road Surat",
      propertyStatus: "approved",
      isVisibility: true,
      whoCreated: actor._id,
    });
    log("Created test property (no seed found)");
  } else {
    log(`Using seed property: ${property.name}`);
  }

  const lead = await leadFacade.createLead(
    {
      name: `Proposal Flow Client ${stamp}`,
      contactPerson: "Test Client",
      contactNumber: `5555${String(stamp).slice(-6)}`,
      email: `proposal-flow-${stamp}@example.com`,
      state: "Gujarat",
      priority: "Hot",
      remarks: "Office ~1200 sqft Varachha Surat",
    },
    { type: "user", userId: actor._id }
  );

  const { client, correlationId } = await leadFacade.convertLeadToClient(
    lead._id,
    { priority: "Hot", assignedTo: assignee._id },
    { type: "user", userId: actor._id }
  );

  await Client.findByIdAndUpdate(client._id, {
    city: "Surat",
    preferredArea: "Varachha",
    expectedRent: "450000",
    minimumArea: "1000",
    requirement: "office 1200 sqft",
    kindOfBusiness: "office",
  });

  const linkResult = await linkFacade.linkPropertyToClient({
    clientId: client._id,
    propertyId: property._id,
    userId: actor._id,
    actorMeta: { correlationId: lead.correlationId || client.correlationId },
    skipNotifications: true,
  });

  if (linkResult.error) {
    throw new Error(`Link failed: ${linkResult.error}`);
  }

  const opportunity =
    linkResult.opportunity ||
    (await Opportunity.findOne({ client: client._id, property: property._id }));

  await drainOutbox();
  await runInlineOrchestration(correlationId, 12);

  return {
    lead,
    client: await Client.findById(client._id),
    property,
    opportunity,
    correlationId,
  };
}

async function assertProposalSent(bundle) {
  const { correlationId, opportunity } = bundle;

  const opp = await Opportunity.findById(opportunity._id).lean();
  record("Proposal email sent (proposalEmailSentAt)", Boolean(opp?.proposalEmailSentAt));
  record("Proposal verified", Boolean(opp?.verifiedProposal));

  const sentEvent = await DomainEvent.findOne({ correlationId, eventType: "proposal.sent" }).lean();
  record("DomainEvent proposal.sent", Boolean(sentEvent));

  const proposalLog = await AgentLog.findOne({
    correlationId,
    agentName: "ProposalAgent",
  }).lean();
  record("AgentLog ProposalAgent", Boolean(proposalLog));

  const link = buildProposalPublicUrl(opportunity._id.toString());
  record("Proposal public URL uses CRM_FRONTEND_URL", link.includes("/proposal/public/"), link);

  try {
    const job = await getFollowUpQueue().getJob(proposalFollowUpJobId(opportunity._id.toString()));
    record("SLA follow-up job scheduled", Boolean(job), job ? `delay ~${job.opts?.delay}ms` : "missing");
  } catch (err) {
    record("SLA follow-up job scheduled", false, err.message);
  }

  return opp;
}

async function assertNoEarlySiteVisit(correlationId, opportunityId) {
  const early = await AgentAction.findOne({
    correlationId,
    intent: "propose_site_visit",
  }).lean();
  const opp = await Opportunity.findById(opportunityId).select("proposalEmailSentAt").lean();
  const ok = !early || Boolean(opp?.proposalEmailSentAt);
  record(
    "Site visit only after proposal sent",
    ok,
    early && !opp?.proposalEmailSentAt ? "site visit before proposal" : "OK"
  );
}

async function simulateProposalViewed(bundle) {
  const { opportunity, correlationId } = bundle;
  await ProposalVisit.create({
    opportunityId: opportunity._id,
    visitorEmail: "proposal-flow-test@example.com",
    userAgent: "test-script",
  });

  await enqueueOutboxEvent({
    eventType: "proposal.viewed",
    aggregateType: "Opportunity",
    aggregateId: opportunity._id,
    correlationId,
    schemaVersion: 1,
    metadata: { actor: "client" },
    payload: {
      opportunityId: opportunity._id.toString(),
      correlationId,
    },
  });

  await runInlineOrchestration(correlationId, 10);
}

async function assertSiteVisitProposed(correlationId) {
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
  record("AgentAction propose_site_visit pending", Boolean(action), action?._id?.toString());
  return action;
}

async function approveSiteVisit(action, actor, opportunityId) {
  const doc = await agentActionService.getById(action._id);
  const exec = await dealExecutionService.executeApprovedDealAction(doc, actor._id);
  if (exec.error) {
    record("Approve site visit", false, exec.error);
    return;
  }
  record("Approve site visit", true, exec.status);

  const opp = await Opportunity.findById(opportunityId).lean();
  record(
    "Opportunity status = Planning for Site Visit",
    opp?.status === "Planning for Site Visit",
    opp?.status
  );

  const task = await FollowUpTask.findOne({
    opportunity: opportunityId,
    taskType: "site_visit",
  }).lean();
  record("FollowUpTask site_visit created", Boolean(task));

  const journey = await JourneyProcess.findOne({ correlationId: doc.correlationId }).lean();
  record("JourneyProcess step site_visit_scheduled", journey?.currentStep === "site_visit_scheduled");

  const paused = await isAiPaused(doc.correlationId);
  record("AI paused after site visit", paused, journey?.pausedReason || "");
}

async function cleanup(bundle) {
  const { correlationId, lead, client, property, opportunity } = bundle;
  if (correlationId) {
    const eventIds = (
      await DomainEvent.find({ correlationId }).select("eventId").lean()
    ).map((e) => e.eventId);
    await AgentAction.deleteMany({ correlationId });
    await AgentLog.deleteMany({ correlationId });
    if (opportunity?._id) {
      await FollowUpTask.deleteMany({ opportunity: opportunity._id });
      await ProposalVisit.deleteMany({ opportunityId: opportunity._id });
      try {
        const job = await getFollowUpQueue().getJob(
          proposalFollowUpJobId(opportunity._id.toString())
        );
        if (job) await job.remove();
      } catch (_) {
        /* ignore */
      }
    }
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
  if (property?._id && !property.name?.includes("Surat Varachha")) {
    await Property.deleteOne({ _id: property._id });
  }
  record("Cleanup test data", true);
}

(async () => {
  if (!isOrchestrationEnabled()) {
    console.error("Orchestration disabled — set AGENT_ORCHESTRATION_ENABLED and REDIS_URL.");
    process.exit(1);
  }

  await connectDB();
  await seedCommunicationTemplates();

  const actor = await findActor();
  const assignee =
    (await User.findOne({ role: "Lead-Employee", status: "Active" })) || actor;
  if (!actor) {
    console.error("Need Super Admin or Manager user.");
    process.exit(1);
  }

  const prevAutomation = await getAutomationSettings(true);
  await updateAutomationSettings(
    { ...prevAutomation, autoSendProposalEmail: true },
    actor._id
  );

  const stamp = Date.now();
  log(`Actor: ${actor.email}`);
  log("NOTE: If production crm-worker shares this Redis, deploy latest code + enable autoSendProposalEmail there too.");
  log("Step 1 — Create client + link property + opportunity");

  const bundle = await setupLinkedOpportunity(actor, assignee, stamp);
  if (!bundle.opportunity) {
    console.error("Failed to create opportunity");
    process.exit(1);
  }
  log(`Opportunity ${bundle.opportunity._id} correlationId=${bundle.correlationId}`);

  log("\nStep 2 — Verify proposal sent (no site visit yet)");
  await assertProposalSent(bundle);
  await assertNoEarlySiteVisit(bundle.correlationId, bundle.opportunity._id);

  log("\nStep 3 — Simulate client opening proposal link");
  await simulateProposalViewed(bundle);

  const viewedEvent = await DomainEvent.findOne({
    correlationId: bundle.correlationId,
    eventType: "proposal.viewed",
  }).lean();
  record("DomainEvent proposal.viewed", Boolean(viewedEvent));

  log("\nStep 4 — Site visit should appear in AI Hub queue");
  const siteVisitAction = await assertSiteVisitProposed(bundle.correlationId);

  if (siteVisitAction) {
    log("\nStep 5 — Approve site visit → AI pauses (manual mode)");
    await approveSiteVisit(siteVisitAction, actor, bundle.opportunity._id);
  } else {
    record("Approve site visit", false, "no pending action");
  }

  await updateAutomationSettings(prevAutomation, actor._id);

  if (!opts.keep) {
    log("\nCleaning up...");
    await cleanup(bundle);
  } else {
    log("\n--keep: test data left in DB");
    log(`Proposal URL: ${buildProposalPublicUrl(bundle.opportunity._id.toString())}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log("\n========================================");
  console.log(`Results: ${results.length - failed}/${results.length} passed`);
  console.log("========================================");
  if (failed) {
    results.filter((r) => !r.ok).forEach((r) => {
      console.log(`  FAIL: ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    });
    process.exitCode = 1;
  }

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
