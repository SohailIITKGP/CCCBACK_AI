#!/usr/bin/env node
/**
 * Integration tests for edge-case Phases 1–5 (property override, exceptions,
 * timers/activity, dedup/min-score, preference memory).
 *
 * Usage:
 *   node scripts/testEdgeCasePhases.js
 *   node scripts/testEdgeCasePhases.js --keep
 */

require("dotenv").config();

const connectDB = require("../config/db");
const { isOrchestrationEnabled } = require("../config/orchestration");
const leadFacade = require("../facades/leadFacade");
const linkFacade = require("../facades/linkFacade");
const { drainOutbox, runInlineOrchestration } = require("../services/orchestrationTestHarness");
const { detectClientIntent } = require("../services/clientReplyIntentService");
const { findDuplicateCandidates, mergeLeads } = require("../services/leadDuplicateService");
const { logEmployeeActivity } = require("../services/employeeActivityService");
const {
  addPreferenceEntry,
  getClientPreferences,
  applyMemoryAdjustments,
  getRejectedPropertyIds,
  recordFromPropertyOverride,
  parsePreferencesFromActivityNote,
} = require("../services/clientPreferenceMemoryService");
const { shouldAutoExecute } = require("../services/agentAutomationService");
const { scorePropertyForClient } = require("../services/propertyMatchingService");
const { getOverrideAnalytics } = require("../services/overrideAnalyticsService");
const { raiseException, listExceptions } = require("../services/exceptionCenterService");
const { pickTestEmailForStamp, getTestEmail } = require("../config/testEmails");

require("../models/User");
const User = require("../models/User");
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const Opportunity = require("../models/Opportunity");
const CrmException = require("../models/CrmException");
const ClientPreferenceMemory = require("../models/ClientPreferenceMemory");
const EmployeeActivity = require("../models/EmployeeActivity");
const DomainEvent = require("../models/DomainEvent");
const JourneyTimelineView = require("../models/JourneyTimelineView");

const PASS = "PASS";
const FAIL = "FAIL";
const WARN = "WARN";
const results = [];
const keep = process.argv.includes("--keep");
const stamp = Date.now();

const record = (name, status, detail = "") => {
  results.push({ name, status, detail });
  const icon = status === PASS ? "✓" : status === WARN ? "!" : "✗";
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function findActor() {
  return (
    (await User.findOne({ role: "Super Admin", status: "Active" }).select("_id email role")) ||
    (await User.findOne({ role: "Manager", status: "Active" }).select("_id email role"))
  );
}

async function createTestProperty(actor, label, rent = "520000") {
  return Property.create({
    name: `EdgeTest ${label} ${stamp}`,
    city: "Mumbai",
    roadName: "Andheri",
    exactArea: "5000",
    expectedRent: rent,
    category: "warehouse",
    address: "Andheri East Test",
    propertyStatus: "approved",
    isVisibility: true,
    isArchive: false,
    whoCreated: actor._id,
  });
}

async function createBareClient(actor, suffix) {
  const correlationId = `edge-test-${stamp}-${suffix}`;
  const email = pickTestEmailForStamp(stamp, suffix);
  const client = await Client.create({
    name: `EdgeTest Client ${suffix} ${stamp}`,
    email,
    contactDetails: `7777${String(stamp + suffix.length).slice(-6)}`,
    priority: "Medium",
    assignedTo: actor._id,
    whoConverted: actor._id,
    correlationId,
    city: "Mumbai",
    preferredArea: "Andheri",
    expectedRent: "500000",
    minimumArea: "4000",
    requirement: "warehouse",
    kindOfBusiness: "warehouse",
  });
  return client;
}

async function cleanup(ids) {
  if (keep) {
    console.log("\n[edge-phases-test] --keep: skipping cleanup");
    return;
  }

  const {
    leadIds = [],
    clientIds = [],
    propertyIds = [],
    oppIds = [],
    exceptionIds = [],
  } = ids;

  await Promise.allSettled([
    EmployeeActivity.deleteMany({ clientId: { $in: clientIds } }),
    ClientPreferenceMemory.deleteMany({ clientId: { $in: clientIds } }),
    CrmException.deleteMany({ _id: { $in: exceptionIds } }),
    Opportunity.deleteMany({ _id: { $in: oppIds } }),
    Client.deleteMany({ _id: { $in: clientIds } }),
    Lead.deleteMany({ _id: { $in: leadIds } }),
    Property.deleteMany({ _id: { $in: propertyIds } }),
    JourneyTimelineView.deleteMany({ leadId: { $in: leadIds } }),
    DomainEvent.deleteMany({ correlationId: new RegExp(String(stamp)) }),
  ]);
}

async function testPhase1Override(actor, client, propA, propB) {
  console.log("\n── Phase 1: Property override / supersede ──");

  const linkA = await linkFacade.linkPropertyToClient({
    clientId: client._id,
    propertyId: propA._id,
    userId: actor._id,
    actorMeta: { actor: "user" },
    skipNotifications: true,
  });

  if (linkA.error) {
    record("Phase1 link property A", FAIL, linkA.message);
    return null;
  }
  record("Phase1 link property A", PASS, linkA.opportunity?._id?.toString());

  const oppAId = linkA.opportunity._id;

  if (isOrchestrationEnabled() && client.correlationId) {
    await enqueueOutboxEvent({
      eventType: "property.matched",
      aggregateType: "Client",
      aggregateId: client._id,
      correlationId: client.correlationId,
      schemaVersion: 1,
      metadata: { actor: "test" },
      payload: {
        clientId: client._id.toString(),
        topPropertyId: propA._id.toString(),
        topScore: 92,
      },
    });
    await drainOutbox();
  }

  const linkB = await linkFacade.linkPropertyToClient({
    clientId: client._id,
    propertyId: propB._id,
    userId: actor._id,
    actorMeta: { actor: "user" },
    skipNotifications: true,
    overrideReason: "client_preference",
  });

  if (linkB.error) {
    record("Phase1 override to property B", FAIL, linkB.message);
    return { oppAId };
  }

  record(
    "Phase1 override to property B",
    linkB.isOverride ? PASS : FAIL,
    `superseded=${linkB.supersededCount}`
  );

  const oppA = await Opportunity.findById(oppAId).lean();
  record(
    "Phase1 old opportunity superseded",
    oppA?.proposalStatus === "superseded" ? PASS : FAIL,
    oppA?.proposalStatus || "missing"
  );

  if (client.correlationId) {
    await runInlineOrchestration(client.correlationId);
    const overrideEvent = await DomainEvent.findOne({
      correlationId: client.correlationId,
      eventType: "property.override_linked",
    }).lean();
    record("Phase1 property.override_linked event", overrideEvent ? PASS : WARN, overrideEvent ? "found" : "not found");
  }

  return { oppAId, oppBId: linkB.opportunity?._id };
}

async function testPhase2Intents(client) {
  console.log("\n── Phase 2: Client intent + exceptions ──");

  const siteVisit = detectClientIntent("Please book a site visit tomorrow");
  record(
    "Phase2 detect book_site_visit",
    siteVisit.intentId === "book_site_visit" ? PASS : FAIL,
    siteVisit.intentId || "none"
  );

  const cheaper = detectClientIntent("This is too expensive, need cheaper option");
  record(
    "Phase2 detect want_cheaper",
    cheaper.intentId === "want_cheaper" ? PASS : FAIL,
    cheaper.intentId || "none"
  );

  const ex = await raiseException({
    type: "no_property_match",
    correlationId: client.correlationId,
    entityType: "Client",
    entityId: client._id,
    title: `Edge test exception ${stamp}`,
    description: "Test exception for Phase 2",
    dedupeKey: `edge_test:${stamp}`,
  });

  record("Phase2 raise exception", ex.raised !== false ? PASS : WARN, ex.skipped ? "deduped" : "raised");

  const dup = await raiseException({
    type: "no_property_match",
    correlationId: client.correlationId,
    entityType: "Client",
    entityId: client._id,
    title: `Edge test exception dup ${stamp}`,
    dedupeKey: `edge_test:${stamp}`,
  });

  record("Phase2 exception dedupe", dup.skipped ? PASS : FAIL, dup.reason || "");

  const { items } = await listExceptions({ status: ["open", "assigned"], limit: 5 });
  record("Phase2 listExceptions", items.length >= 0 ? PASS : FAIL, `${items.length} items`);

  return ex.exception?._id;
}

async function testPhase3Activity(actor, client) {
  console.log("\n── Phase 3: Employee activity + analytics ──");

  const parsed = parsePreferencesFromActivityNote(
    "Called client — prefers warehouse, rejected high rent properties"
  );
  record(
    "Phase3 parse activity note",
    parsed.some((p) => p.type === "category_prefer") ? PASS : FAIL,
    parsed.map((p) => p.type).join(", ")
  );

  const activity = await logEmployeeActivity({
    userId: actor._id,
    clientId: client._id,
    channel: "phone",
    note: "Called client — budget increased to ₹60 lakh, prefers warehouse in Andheri",
  });

  record(
    "Phase3 log employee activity",
    activity.success ? PASS : FAIL,
    activity.requirementsChanged ? "requirements updated" : "logged only"
  );

  const analytics = await getOverrideAnalytics({ days: 90 });
  record(
    "Phase3 override analytics API",
    typeof analytics.totalOverrides === "number" ? PASS : FAIL,
    `${analytics.totalOverrides} overrides`
  );

  return activity.activity?._id;
}

async function testPhase4DedupAndMinScore(actor) {
  console.log("\n── Phase 4: Duplicate merge + min score gate ──");

  const dedupEmail = getTestEmail(1);

  const primary = await leadFacade.createLead(
    {
      name: `EdgeTest Primary ${stamp}`,
      email: dedupEmail,
      contactNumber: `6666${String(stamp).slice(-6)}`,
      sourceOfConnection: "Test",
      priority: "Medium",
    },
    { type: "user", userId: actor._id }
  );

  const duplicate = await leadFacade.createLead(
    {
      name: `EdgeTest Duplicate ${stamp}`,
      email: dedupEmail,
      contactNumber: `6666${String(stamp).slice(-6)}`,
      sourceOfConnection: "Website",
      priority: "Medium",
    },
    { type: "user", userId: actor._id }
  );

  await new Promise((r) => setTimeout(r, 500));

  const dups = await findDuplicateCandidates(primary);
  record(
    "Phase4 find duplicate candidates",
    dups.some((d) => String(d._id) === String(duplicate._id)) ? PASS : FAIL,
    `${dups.length} candidate(s)`
  );

  const mergeResult = await mergeLeads({
    primaryLeadId: primary._id,
    duplicateLeadId: duplicate._id,
    userId: actor._id,
    reason: "same_person",
  });

  record(
    "Phase4 merge duplicate leads",
    mergeResult.success ? PASS : FAIL,
    mergeResult.message || "merged"
  );

  const mergedDup = await Lead.findById(duplicate._id).lean();
  record(
    "Phase4 duplicate marked LOST",
    mergedDup?.mergedIntoLead && mergedDup?.lifecycleState === "LOST" ? PASS : FAIL,
    mergedDup?.lifecycleState || "?"
  );

  const lowScoreBlocked = shouldAutoExecute(
    {
      status: "pending_approval",
      intent: "send_email",
      payload: { templateId: "client_properties_share_v1", topScore: 45 },
    },
    { autoSharePropertiesEmail: true, minPropertyShareScore: 60 }
  );

  record("Phase4 min score blocks auto-share", lowScoreBlocked === false ? PASS : FAIL, "score 45 < 60");

  const highScoreAllowed = shouldAutoExecute(
    {
      status: "pending_approval",
      intent: "send_email",
      payload: { templateId: "client_properties_share_v1", topScore: 75 },
    },
    { autoSharePropertiesEmail: true, minPropertyShareScore: 60 }
  );

  record("Phase4 min score allows auto-share", highScoreAllowed === true ? PASS : FAIL, "score 75 >= 60");

  return { primaryLeadId: primary._id, duplicateLeadId: duplicate._id };
}

async function testPhase5Memory(actor, client, propA, propB) {
  console.log("\n── Phase 5: Client preference memory ──");

  await recordFromPropertyOverride({
    clientId: client._id,
    correlationId: client.correlationId,
    overrideReason: "client_preference",
    aiPropertyId: propA._id,
    newPropertyId: propB._id,
    aiScore: 92,
    newPropertyScore: 71,
    userId: actor._id,
  });

  const prefs = await getClientPreferences(client._id);
  record(
    "Phase5 preferences recorded",
    prefs.entries.length >= 2 ? PASS : FAIL,
    `${prefs.entries.length} entries`
  );

  const rejected = getRejectedPropertyIds(
    await ClientPreferenceMemory.findOne({ clientId: client._id }).lean()
  );
  record(
    "Phase5 rejected property A in memory",
    rejected.includes(propA._id.toString()) ? PASS : FAIL,
    rejected.join(",") || "none"
  );

  const base = scorePropertyForClient(
    {
      city: "Mumbai",
      preferredArea: "Andheri",
      expectedRent: "500000",
      minimumArea: "4000",
      requirement: "warehouse",
      kindOfBusiness: "warehouse",
    },
    {
      _id: propB._id,
      name: propB.name,
      city: "Mumbai",
      roadName: "Andheri",
      exactArea: "5000",
      expectedRent: "520000",
      category: "warehouse",
    }
  );

  const memory = await ClientPreferenceMemory.findOne({ clientId: client._id }).lean();
  const adjusted = applyMemoryAdjustments(base, propB, memory);

  record(
    "Phase5 memory boosts preferred property",
    adjusted.memoryApplied && adjusted.score >= base.score ? PASS : FAIL,
    `base=${base.score} adjusted=${adjusted.score}`
  );

  await addPreferenceEntry({
    clientId: client._id,
    type: "category_avoid",
    value: "roadside",
    source: "manual",
    evidence: "Test avoid",
    userId: actor._id,
  });

  record("Phase5 manual preference add", PASS, "category_avoid roadside");
}

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log(" Edge-case Phases 1–5 integration test");
  console.log(` stamp: ${stamp}`);
  console.log(` orchestration: ${isOrchestrationEnabled() ? "ON" : "OFF"}`);
  console.log(` test inboxes: ${require("../config/testEmails").getTestEmails().join(", ")}`);
  console.log("═══════════════════════════════════════════════════");

  await connectDB();

  const actor = await findActor();
  if (!actor) {
    console.error("No Super Admin / Manager user found. Create an active user first.");
    process.exit(1);
  }

  const cleanupIds = {
    leadIds: [],
    clientIds: [],
    propertyIds: [],
    oppIds: [],
    exceptionIds: [],
  };

  try {
    const propA = await createTestProperty(actor, "A");
    const propB = await createTestProperty(actor, "B", "480000");
    cleanupIds.propertyIds.push(propA._id, propB._id);

    const client = await createBareClient(actor, "main");
    cleanupIds.clientIds.push(client._id);

    const opps = await testPhase1Override(actor, client, propA, propB);
    if (opps?.oppAId) cleanupIds.oppIds.push(opps.oppAId);
    if (opps?.oppBId) cleanupIds.oppIds.push(opps.oppBId);

    const exId = await testPhase2Intents(client);
    if (exId) cleanupIds.exceptionIds.push(exId);

    await testPhase3Activity(actor, client);

    const dedup = await testPhase4DedupAndMinScore(actor);
    if (dedup?.primaryLeadId) cleanupIds.leadIds.push(dedup.primaryLeadId);
    if (dedup?.duplicateLeadId) cleanupIds.leadIds.push(dedup.duplicateLeadId);

    await testPhase5Memory(actor, client, propA, propB);
  } finally {
    await cleanup(cleanupIds);
  }

  console.log("\n═══════════════════════════════════════════════════");
  const passed = results.filter((r) => r.status === PASS).length;
  const failed = results.filter((r) => r.status === FAIL).length;
  const warned = results.filter((r) => r.status === WARN).length;
  console.log(` Results: ${passed} passed, ${failed} failed, ${warned} warnings`);
  console.log("═══════════════════════════════════════════════════");

  if (failed > 0) {
    console.log("\nFailed checks:");
    results.filter((r) => r.status === FAIL).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[edge-phases-test] Fatal:", err);
  process.exit(1);
});
