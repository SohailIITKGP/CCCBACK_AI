#!/usr/bin/env node
/**
 * Creates test lead(s), sends welcome email, prints reply + curl instructions.
 *
 * Usage:
 *   node scripts/setupEmailReplyTest.js
 *   node scripts/setupEmailReplyTest.js --email=nishuk7898@gmail.com
 *   node scripts/setupEmailReplyTest.js --all
 *
 * Env: TEST_LEAD_EMAIL or TEST_LEAD_EMAILS (comma-separated) overrides defaults.
 */

require("dotenv").config();

const connectDB = require("../config/db");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { resolveTestEmailsFromArgs, getTestEmails } = require("../config/testEmails");
const leadFacade = require("../facades/leadFacade");
const { runInlineOrchestration } = require("../services/orchestrationTestHarness");
const agentActionExecutionService = require("../services/agentActionExecutionService");

require("../models/User");
const User = require("../models/User");
const AgentAction = require("../models/AgentAction");

const REPLY_BODY = `City: Mumbai
Area: Andheri East
Size: 5000 sqft
Rent: Rs 5,00,000
Need warehouse space for logistics.`;

const API_BASE =
  process.env.TEST_API_BASE ||
  process.env.CRM_API_URL ||
  "https://ai.webwonders.co.in/api";

async function findActor(preferredEmail) {
  if (preferredEmail) {
    const byEmail = await User.findOne({ email: preferredEmail, status: "Active" });
    if (byEmail) return byEmail;
  }
  return (
    (await User.findOne({ role: "Super Admin", status: "Active" })) ||
    (await User.findOne({ role: "Manager", status: "Active" }))
  );
}

async function setupOneLead({ testEmail, actor, stamp, index }) {
  const lead = await leadFacade.createLead(
    {
      name: `Reply Test ${index + 1} ${new Date().toLocaleDateString("en-IN")}`,
      contactNumber: `8888${String(stamp + index).slice(-6)}`,
      email: testEmail,
      contactPerson: actor.name || "Test User",
      priority: "Hot",
      assignedTo: actor._id,
      remarks: "Email reply test — reply with city, area, size, rent",
    },
    { type: "user", userId: actor._id }
  );

  console.log(`\n✓ Lead created for ${testEmail}`);
  console.log(`  ID: ${lead._id}`);
  console.log(`  correlationId: ${lead.correlationId}`);

  await runInlineOrchestration(lead.correlationId, 8);

  const emailAction = await AgentAction.findOne({
    correlationId: lead.correlationId,
    intent: "send_email",
    status: "pending_approval",
  });

  if (emailAction) {
    const sent = await agentActionExecutionService.executeAction(emailAction, actor._id);
    if (sent.error) {
      console.log(`  ⚠ Welcome email not sent: ${sent.error} ${sent.reason || ""}`);
    } else {
      console.log(`  ✓ Welcome email sent → ${testEmail}`);
    }
  } else {
    const executed = await AgentAction.findOne({
      correlationId: lead.correlationId,
      intent: "send_email",
      status: "executed",
    });
    console.log(
      executed
        ? `  ✓ Welcome email already sent (automation)`
        : `  ⚠ No welcome email action — check AI Hub / worker`
    );
  }

  return lead;
}

function printReplyInstructions(testEmails) {
  const secret = (process.env.CHANNEL_WEBHOOK_SECRET || "your-secret").split("#")[0].trim();

  console.log("\n═══════════════════════════════════════════════════");
  console.log(" REPLY TEST — use a REAL inbox (check spam too)");
  console.log("═══════════════════════════════════════════════════");
  console.log("\nPaste this in your Gmail reply:\n");
  console.log(REPLY_BODY);

  console.log("\n--- Option A: Gmail poller (production) ---");
  console.log("Reply in Gmail from the SAME address as the lead.");
  console.log("Worker polls every ~90s if GMAIL_INBOUND_ENABLED=true.");

  console.log("\n--- Option B: Simulate inbound (instant) ---");
  for (const testEmail of testEmails) {
    const bodyJson = JSON.stringify({
      fromEmail: testEmail,
      subject: "Re: warehouse inquiry",
      body: REPLY_BODY,
    });
    console.log(`\n# ${testEmail}`);
    console.log(
      `curl -X POST ${API_BASE}/channels/email/inbound \\\n` +
        `  -H "Content-Type: application/json" \\\n` +
        `  -H "x-webhook-secret: ${secret}" \\\n` +
        `  -d '${bodyJson}'`
    );
  }

  console.log("\n--- Then check ---");
  console.log("• Lead modal → Email communication (reply visible)");
  console.log("• AI Agent Hub → convert / match actions");
  console.log("• Journey: /journey/<correlationId>");
  console.log("\nConfigured test inboxes:", getTestEmails().join(", "));
}

(async () => {
  if (!isOrchestrationEnabled()) {
    console.error("Set AGENT_ORCHESTRATION_ENABLED=true and REDIS_URL");
    process.exit(1);
  }

  const testEmails = resolveTestEmailsFromArgs();
  const stamp = Date.now();

  await connectDB();
  const actor = await findActor(testEmails[0]);
  if (!actor) {
    console.error("No Super Admin / Manager user found");
    process.exit(1);
  }

  console.log("Using test inbox(es):", testEmails.join(", "));

  for (let i = 0; i < testEmails.length; i += 1) {
    await setupOneLead({ testEmail: testEmails[i], actor, stamp, index: i });
  }

  printReplyInstructions(testEmails);

  await require("mongoose").disconnect();
  await require("../queues/connection").closeRedisConnection();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try {
    await require("../queues/connection").closeRedisConnection();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
