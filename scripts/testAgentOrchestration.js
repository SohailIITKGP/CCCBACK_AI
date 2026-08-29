#!/usr/bin/env node
/**
 * Phase 0 + Phase 1 orchestration test harness.
 *
 * Creates a test lead, verifies event pipeline (Phase 0) and agent flow (Phase 1).
 *
 * Usage:
 *   node scripts/testAgentOrchestration.js                 # inline mode (no worker required)
 *   node scripts/testAgentOrchestration.js --wait-worker   # poll DB while worker runs
 *   node scripts/testAgentOrchestration.js --phase0        # Phase 0 checks only
 *   node scripts/testAgentOrchestration.js --with-api      # also hit REST APIs
 *   node scripts/testAgentOrchestration.js --approve       # approve draft (sends real email!)
 *   node scripts/testAgentOrchestration.js --reject        # test reject on 2nd lead
 *   node scripts/testAgentOrchestration.js --keep          # do not delete test leads
 *
 * Env (optional for --with-api):
 *   TEST_API_BASE=http://localhost:5000/api
 *   TEST_ADMIN_EMAIL=manager@example.com
 *   TEST_ADMIN_PASSWORD=secret
 *   TEST_LEAD_EMAIL=you@example.com   # inbox for draft email tests
 */

require("dotenv").config();

const axios = require("axios");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { seedCommunicationTemplates } = require("../services/templateService");
const leadFacade = require("../facades/leadFacade");
const {
  drainOutbox,
  runInlineOrchestration,
  sleep,
} = require("../services/orchestrationTestHarness");

require("../models/User");
const User = require("../models/User");
const Lead = require("../models/Lead");
const OutboxEvent = require("../models/OutboxEvent");
const DomainEvent = require("../models/DomainEvent");
const AgentLog = require("../models/AgentLog");
const AgentAction = require("../models/AgentAction");
const JourneyProcess = require("../models/JourneyProcess");
const JourneyTimelineView = require("../models/JourneyTimelineView");
const ProcessedEvent = require("../models/ProcessedEvent");

const PASS = "PASS";
const FAIL = "FAIL";
const WARN = "WARN";

const results = [];

const parseArgs = () => {
  const args = process.argv.slice(2);
  return {
    phase0Only: args.includes("--phase0"),
    phase1Only: args.includes("--phase1"),
    inline: !args.includes("--wait-worker"),
    withApi: args.includes("--with-api"),
    approve: args.includes("--approve"),
    reject: args.includes("--reject"),
    keep: args.includes("--keep"),
    help: args.includes("--help") || args.includes("-h"),
  };
};

const log = (...parts) => console.log("[orchestration-test]", ...parts);

const record = (name, status, detail = "") => {
  results.push({ name, status, detail });
  const icon = status === PASS ? "✓" : status === WARN ? "!" : "✗";
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleepMs = (ms) => sleep(ms);

async function findActorUser() {
  return (
    (await User.findOne({ role: "Super Admin", status: "Active" }).select("_id email role")) ||
    (await User.findOne({ role: "Manager", status: "Active" }).select("_id email role")) ||
    (await User.findOne({ role: { $in: ["Super Admin", "Manager"] } }).select("_id email role"))
  );
}

async function createTestLead(actor, suffix, email) {
  const stamp = Date.now();
  return leadFacade.createLead(
    {
      name: `Orchestration Test ${suffix} ${stamp}`,
      contactPerson: "Test User",
      contactNumber: `9999${String(stamp).slice(-6)}`,
      email: email || `orchestration-test-${stamp}@example.com`,
      state: "Maharashtra",
      sourceOfConnection: "Referral",
      remarks: `Urgent warehouse 5000 sqft Andheri test run ${suffix}`,
      priority: "Medium",
    },
    { type: "user", userId: actor._id },
    { ipAddress: "127.0.0.1" }
  );
}

async function assertPhase0(correlationId, leadId) {
  log("\nPhase 0 — Event pipeline");

  const lead = await Lead.findById(leadId).lean();
  if (lead?.correlationId === correlationId) {
    record("Lead has correlationId", PASS, correlationId);
  } else {
    record("Lead has correlationId", FAIL, `got ${lead?.correlationId}`);
  }

  const outbox = await OutboxEvent.findOne({
    correlationId,
    eventType: "lead.created",
  }).lean();
  if (outbox?.status === "published") {
    record("Outbox lead.created published", PASS);
  } else if (outbox?.status === "pending") {
    record("Outbox lead.created published", FAIL, "still pending");
  } else {
    record("Outbox lead.created published", FAIL, "not found");
  }

  const domain = await DomainEvent.findOne({
    correlationId,
    eventType: "lead.created",
  }).lean();
  if (domain) {
    record("DomainEvent lead.created", PASS, domain.eventId);
  } else {
    record("DomainEvent lead.created", FAIL);
  }

  const agentLog = await AgentLog.findOne({
    correlationId,
    eventType: "lead.created",
    workerName: "orchestrator",
  }).lean();
  if (agentLog) {
    record("AgentLog orchestrator received lead.created", PASS);
  } else {
    const legacyLog = await AgentLog.findOne({
      correlationId,
      message: /Event received: lead\.created/,
    }).lean();
    if (legacyLog) {
      record("AgentLog orchestrator received lead.created", PASS, "legacy log format");
    } else {
      record("AgentLog orchestrator received lead.created", FAIL);
    }
  }
}

async function assertPhase1(correlationId, leadId) {
  log("\nPhase 1 — Agents + HITL draft");

  const lead = await Lead.findById(leadId).lean();
  if (lead?.lifecycleState === "QUALIFIED") {
    record("Lead lifecycleState QUALIFIED", PASS);
  } else {
    record("Lead lifecycleState QUALIFIED", FAIL, `got ${lead?.lifecycleState}`);
  }

  if (["Hot", "High", "Medium"].includes(lead?.priority)) {
    record("Lead priority set by rules", PASS, lead.priority);
  } else {
    record("Lead priority set by rules", FAIL, `got ${lead?.priority}`);
  }

  const qualifiedEvent = await DomainEvent.findOne({
    correlationId,
    eventType: "lead.qualified",
  }).lean();
  if (qualifiedEvent) {
    record("DomainEvent lead.qualified", PASS);
  } else {
    record("DomainEvent lead.qualified", FAIL);
  }

  const journey = await JourneyProcess.findOne({ correlationId }).lean();
  if (journey?.currentPhase === "NURTURE" || journey?.currentPhase === "ACQUIRE") {
    record("JourneyProcess created", PASS, `phase=${journey.currentPhase}`);
  } else {
    record("JourneyProcess created", FAIL, journey ? `phase=${journey.currentPhase}` : "missing");
  }

  const pendingAction = await AgentAction.findOne({
    correlationId,
    intent: "send_email",
    status: "pending_approval",
  }).lean();

  if (!lead?.email) {
    record("AgentAction pending email draft", WARN, "lead has no email");
  } else if (pendingAction) {
    record("AgentAction pending email draft", PASS, pendingAction._id.toString());
  } else {
    record("AgentAction pending email draft", FAIL);
  }

  const drafted = await DomainEvent.findOne({
    correlationId,
    eventType: "message.drafted",
  }).lean();
  if (drafted) {
    record("DomainEvent message.drafted", PASS);
  } else if (!lead?.email) {
    record("DomainEvent message.drafted", WARN, "skipped — no email");
  } else {
    record("DomainEvent message.drafted", FAIL);
  }

  const timeline = await JourneyTimelineView.findOne({ correlationId }).lean();
  if (timeline?.timeline?.length >= 2) {
    record("Journey timeline projection", PASS, `${timeline.timeline.length} events`);
  } else {
    record("Journey timeline projection", FAIL, timeline ? `${timeline.timeline?.length || 0} events` : "missing");
  }

  return pendingAction;
}

async function pollUntilPhase1(correlationId, leadId, timeoutMs = 45000) {
  const lead = await Lead.findById(leadId).select("email").lean();
  const needsDraft = Boolean(lead?.email);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const qualified = await DomainEvent.exists({ correlationId, eventType: "lead.qualified" });
    const action = await AgentAction.exists({
      correlationId,
      intent: "send_email",
      status: "pending_approval",
    });
    const drafted = needsDraft
      ? await DomainEvent.exists({ correlationId, eventType: "message.drafted" })
      : true;
    if (qualified && action && drafted) return true;
    await sleepMs(1500);
  }
  return false;
}

async function pollUntilPhase0(correlationId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const published = await OutboxEvent.exists({
      correlationId,
      eventType: "lead.created",
      status: "published",
    });
    const domain = await DomainEvent.exists({
      correlationId,
      eventType: "lead.created",
    });
    if (published && domain) return true;
    await sleepMs(1000);
  }
  return false;
}

async function loginForApi() {
  const base = process.env.TEST_API_BASE || "http://localhost:5000/api";
  const email = process.env.TEST_ADMIN_EMAIL;
  const password = process.env.TEST_ADMIN_PASSWORD;

  if (!email || !password) {
    return { error: "Set TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD for --with-api" };
  }

  try {
    const res = await axios.post(`${base}/auth/login`, { email, password }, { timeout: 15000 });
    const token = res.data?.token || res.data?.data?.token;
    if (!token) return { error: "Login OK but no token in response" };
    return { base, token, client: axios.create({ baseURL: base, headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }) };
  } catch (err) {
    return { error: err.response?.data?.message || err.message };
  }
}

async function testApiEndpoints(client, correlationId) {
  log("\nAPI smoke tests");

  try {
    const status = await client.get("/events/status");
    if (status.data?.orchestrationEnabled) {
      record("GET /events/status", PASS);
    } else {
      record("GET /events/status", FAIL, "orchestration disabled");
    }
  } catch (err) {
    record("GET /events/status", FAIL, err.message);
  }

  try {
    const pending = await client.get("/agents/actions/pending");
    record("GET /agents/actions/pending", PASS, `${pending.data?.count ?? 0} pending`);
  } catch (err) {
    record("GET /agents/actions/pending", FAIL, err.message);
  }

  try {
    const journey = await client.get(`/journey/${correlationId}`);
    if (journey.data?.journey?.timeline?.length >= 1) {
      record("GET /journey/:correlationId", PASS);
    } else {
      record("GET /journey/:correlationId", WARN, "empty timeline");
    }
  } catch (err) {
    record("GET /journey/:correlationId", FAIL, err.message);
  }

  try {
    const summary = await client.get(`/journey/${correlationId}/summary`);
    if (summary.data?.summary) {
      record("GET /journey/:correlationId/summary", PASS);
    } else {
      record("GET /journey/:correlationId/summary", WARN, "no summary text");
    }
  } catch (err) {
    record("GET /journey/:correlationId/summary", FAIL, err.message);
  }
}

async function testApprove(client, actionId) {
  log("\nApprove flow (sends real email if SMTP configured)");
  try {
    const res = await client.post(`/agents/actions/${actionId}/approve`);
    if (res.data?.success && res.data?.execution?.sent) {
      record("POST /agents/actions/:id/approve", PASS, res.data.execution.messageId || "sent");
    } else {
      record("POST /agents/actions/:id/approve", FAIL, JSON.stringify(res.data));
    }
  } catch (err) {
    record("POST /agents/actions/:id/approve", FAIL, err.response?.data?.message || err.message);
  }
}

async function testReject(client, correlationId, actor) {
  log("\nReject flow (second test lead)");
  const lead = await createTestLead(actor, "reject", process.env.TEST_LEAD_EMAIL);
  if (parseArgs().inline) {
    await runInlineOrchestration(lead.correlationId);
  } else {
    await pollUntilPhase1(lead.correlationId, lead._id, 45000);
  }

  const action = await AgentAction.findOne({
    correlationId: lead.correlationId,
    status: "pending_approval",
  });
  if (!action) {
    record("Reject test — pending action", FAIL, "none found");
    return lead;
  }

  try {
    const res = await client.post(`/agents/actions/${action._id}/reject`, {
      reason: "Automated test rejection",
    });
    if (res.data?.success && res.data?.action?.status === "rejected") {
      record("POST /agents/actions/:id/reject", PASS);
    } else {
      record("POST /agents/actions/:id/reject", FAIL);
    }
  } catch (err) {
    record("POST /agents/actions/:id/reject", FAIL, err.message);
  }
  return lead;
}

async function cleanupLeads(leadIds) {
  for (const id of leadIds) {
    const lead = await Lead.findById(id).lean();
    if (!lead?.correlationId) continue;
    const cid = lead.correlationId;
    await AgentAction.deleteMany({ correlationId: cid });
    await JourneyTimelineView.deleteMany({ correlationId: cid });
    await JourneyProcess.deleteMany({ correlationId: cid });
    await AgentLog.deleteMany({ correlationId: cid });
    const eventIds = (
      await DomainEvent.find({ correlationId: cid }).select("eventId").lean()
    ).map((e) => e.eventId);
    await DomainEvent.deleteMany({ correlationId: cid });
    await OutboxEvent.deleteMany({ correlationId: cid });
    if (eventIds.length) {
      await ProcessedEvent.deleteMany({ eventId: { $in: eventIds } });
    }
    await Lead.deleteOne({ _id: id });
  }
}

function printSummary() {
  const passed = results.filter((r) => r.status === PASS).length;
  const failed = results.filter((r) => r.status === FAIL).length;
  const warned = results.filter((r) => r.status === WARN).length;

  console.log("\n========================================");
  console.log(`Results: ${passed} passed, ${failed} failed, ${warned} warnings`);
  console.log("========================================");

  if (failed > 0) {
    console.log("\nFailed checks:");
    results.filter((r) => r.status === FAIL).forEach((r) => {
      console.log(`  - ${r.name}${r.detail ? `: ${r.detail}` : ""}`);
    });
    process.exitCode = 1;
  }
}

function printHelp() {
  console.log(`
Phase 0 + Phase 1 test script

  node scripts/testAgentOrchestration.js [options]

Options:
  --inline        Process outbox + agents in-process (default, no worker needed)
  --wait-worker   Poll MongoDB until worker processes events (worker must be running)
  --phase0        Run Phase 0 checks only
  --phase1        Run Phase 1 checks only (after inline/wait processing)
  --with-api      Call REST APIs (needs TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD)
  --approve       Approve pending draft — sends a real email
  --reject        Create 2nd lead and test reject API
  --keep          Keep test leads/data in DB
  --help          Show this help

Environment:
  TEST_API_BASE=http://localhost:5000/api
  TEST_ADMIN_EMAIL=
  TEST_ADMIN_PASSWORD=
  TEST_LEAD_EMAIL=optional inbox for test lead
`);
}

(async () => {
  const opts = parseArgs();
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  log("Starting orchestration test");
  log(`Mode: ${opts.inline ? "inline (no worker required)" : "wait-worker (npm run worker must be running)"}`);

  if (!isOrchestrationEnabled()) {
    console.error("AGENT_ORCHESTRATION_ENABLED is false or REDIS_URL missing.");
    process.exit(1);
  }

  await connectDB();
  await seedCommunicationTemplates();

  const actor = await findActorUser();
  if (!actor) {
    console.error("No Manager/Super Admin user found in database.");
    process.exit(1);
  }
  log(`Using actor: ${actor.email} (${actor.role})`);

  const testEmail =
    process.env.TEST_LEAD_EMAIL ||
    `orchestration-test-${Date.now()}@example.com`;

  const lead = await createTestLead(actor, "main", testEmail);
  const { correlationId } = lead;
  log(`Created test lead ${lead._id} correlationId=${correlationId}`);

  const createdLeadIds = [lead._id];

  if (opts.inline) {
    log("Running inline outbox + orchestration...");
    log(
      "NOTE: Stop `npm run worker` before inline tests — running both causes duplicate processing."
    );
    const run = await runInlineOrchestration(correlationId);
    log(`Inline pipeline finished after ${run.rounds} round(s)`);
    if (run.exhausted) {
      record("Inline pipeline completed", WARN, "max iterations reached");
    } else {
      record("Inline pipeline completed", PASS);
    }
  } else {
    log("Waiting for worker (Phase 0)...");
    const p0 = await pollUntilPhase0(correlationId);
    if (!p0) {
      record("Worker processed Phase 0", FAIL, "timeout — is npm run worker running?");
    } else {
      record("Worker processed Phase 0", PASS);
    }
    if (!opts.phase0Only) {
      log("Waiting for worker (Phase 1)...");
      const p1 = await pollUntilPhase1(correlationId, lead._id);
      if (!p1) {
        record("Worker processed Phase 1", FAIL, "timeout");
      } else {
        record("Worker processed Phase 1", PASS);
      }
    }
  }

  const runPhase0 = !opts.phase1Only;
  const runPhase1 = !opts.phase0Only;

  if (runPhase0) await assertPhase0(correlationId, lead._id);

  let pendingAction = null;
  if (runPhase1) {
    pendingAction = await assertPhase1(correlationId, lead._id);
  }

  let apiClient = null;
  if (opts.withApi || opts.approve || opts.reject) {
    const auth = await loginForApi();
    if (auth.error) {
      record("API login", FAIL, auth.error);
    } else {
      record("API login", PASS, process.env.TEST_ADMIN_EMAIL);
      apiClient = auth.client;
      if (opts.withApi) await testApiEndpoints(apiClient, correlationId);
    }
  }

  if (opts.approve && apiClient && pendingAction) {
    await testApprove(apiClient, pendingAction._id);
    const sent = await DomainEvent.exists({ correlationId, eventType: "message.sent" });
    if (sent) {
      record("DomainEvent message.sent after approve", PASS);
    } else {
      await sleepMs(3000);
      const sentLater = await DomainEvent.exists({ correlationId, eventType: "message.sent" });
      record("DomainEvent message.sent after approve", sentLater ? PASS : FAIL);
    }
  } else if (opts.approve && !pendingAction) {
    record("Approve test", WARN, "no pending action to approve");
  }

  if (opts.reject && apiClient) {
    const rejectLead = await testReject(apiClient, correlationId, actor);
    if (rejectLead?._id) createdLeadIds.push(rejectLead._id);
  }

  if (!opts.keep) {
    log("\nCleaning up test data...");
    await cleanupLeads(createdLeadIds);
    record("Cleanup test data", PASS);
  } else {
    record("Cleanup test data", WARN, "skipped (--keep)");
    log(`Test lead id: ${lead._id}`);
    log(`correlationId: ${correlationId}`);
  }

  printSummary();
  await mongoose.disconnect();
})().catch((err) => {
  console.error("[orchestration-test] fatal:", err);
  process.exit(1);
});
