#!/usr/bin/env node
/**
 * End-to-end test: inbound email → parse requirements → lead conversion proposal/auto-convert.
 *
 * Usage:
 *   node scripts/testLeadEmailConversion.js              # proposes conversion (automation off)
 *   node scripts/testLeadEmailConversion.js --auto       # enables autoConvertFromEmail for test
 *   node scripts/testLeadEmailConversion.js --keep       # skip cleanup
 *
 * Stop `npm run worker` first for inline mode (or events may process twice).
 */

require("dotenv").config();

const connectDB = require("../config/db");
const { isOrchestrationEnabled } = require("../config/orchestration");
const leadFacade = require("../facades/leadFacade");
const conversationService = require("../services/conversationService");
const { runInlineOrchestration } = require("../services/orchestrationTestHarness");
const {
  parseRequirementsFromEmail,
  isCompleteForConversion,
} = require("../services/emailRequirementParserService");
const {
  getAutomationSettings,
  updateAutomationSettings,
} = require("../services/agentAutomationService");

require("../models/User");
const User = require("../models/User");
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const AgentAction = require("../models/AgentAction");
const AgentLog = require("../models/AgentLog");
const OutboxEvent = require("../models/OutboxEvent");
const DomainEvent = require("../models/DomainEvent");
const Conversation = require("../models/Conversation");
const JourneyProcess = require("../models/JourneyProcess");
const ProcessedEvent = require("../models/ProcessedEvent");

const keep = process.argv.includes("--keep");
const autoMode = process.argv.includes("--auto");

const log = (ok, name, detail = "") =>
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);

const SAMPLE_REPLY = `
Hi Rewa team,

City: Mumbai
Area: Andheri East
Size: 5000 sqft
Rent: Rs 5,00,000
We need warehouse space for logistics operations.

Thanks,
Test Client
`;

(async () => {
  if (!isOrchestrationEnabled()) {
    console.error("Set AGENT_ORCHESTRATION_ENABLED=true in .env");
    process.exit(1);
  }

  await connectDB();
  const actor = await User.findOne({ role: "Super Admin" });
  if (!actor) {
    console.error("No Super Admin user found");
    process.exit(1);
  }

  const stamp = Date.now();
  log(true, "Setup", actor.email);

  const parsed = parseRequirementsFromEmail(SAMPLE_REPLY);
  log(isCompleteForConversion(parsed), "Parser sees complete requirements", parsed.city);

  let prevAutomation = null;
  prevAutomation = await getAutomationSettings(true);
  if (autoMode) {
    await updateAutomationSettings({ ...prevAutomation, autoConvertFromEmail: true }, actor._id);
    log(true, "autoConvertFromEmail enabled for test");
  } else {
    await updateAutomationSettings({ ...prevAutomation, autoConvertFromEmail: false }, actor._id);
    log(true, "autoConvertFromEmail disabled for proposal test");
  }

  const lead = await leadFacade.createLead(
    {
      name: `Email Convert Test ${stamp}`,
      contactNumber: `9999${String(stamp).slice(-6)}`,
      email: `email-convert-${stamp}@example.com`,
      priority: "Hot",
      assignedTo: actor._id,
    },
    { type: "user", userId: actor._id }
  );
  log(true, "Lead created", lead.email);

  await runInlineOrchestration(lead.correlationId, 6);

  await conversationService.recordInboundReply({
    correlationId: lead.correlationId,
    entityType: "Lead",
    entityId: lead._id,
    channel: "email",
    content: SAMPLE_REPLY,
    subject: "Re: warehouse inquiry",
    externalMessageId: `test-reply-${stamp}`,
    actor: lead.email,
  });
  log(true, "Inbound email recorded");

  await runInlineOrchestration(lead.correlationId, 8);

  const refreshedLead = await Lead.findById(lead._id).lean();
  const conversionAction = await AgentAction.findOne({
    correlationId: lead.correlationId,
    intent: "propose_lead_conversion",
  }).lean();
  const client = refreshedLead?.isConverted
    ? await Client.findById(refreshedLead.convertedTo).lean()
    : null;

  if (autoMode) {
    log(Boolean(refreshedLead?.isConverted), "Lead auto-converted");
    log(Boolean(client?.city), "Client has city", client?.city || "—");
    log(Boolean(client?.preferredArea), "Client has area", client?.preferredArea || "—");
  } else {
    log(Boolean(conversionAction), "Conversion proposal in AI Agent Hub");
    log(!refreshedLead?.isConverted, "Lead still open until you approve");
  }

  const conv = await Conversation.findOne({ correlationId: lead.correlationId }).lean();
  log(conv?.channels?.some((c) => c.direction === "inbound"), "Conversation has inbound message");

  const conversionLog = await AgentLog.findOne({
    correlationId: lead.correlationId,
    agentName: "LeadConversionAgent",
  }).lean();
  log(Boolean(conversionLog), "LeadConversionAgent logged activity");

  if (!keep) {
    if (client?._id) await Client.deleteOne({ _id: client._id });
    await Lead.deleteOne({ _id: lead._id });
    await AgentAction.deleteMany({ correlationId: lead.correlationId });
    await AgentLog.deleteMany({ correlationId: lead.correlationId });
    await OutboxEvent.deleteMany({ correlationId: lead.correlationId });
    await DomainEvent.deleteMany({ correlationId: lead.correlationId });
    await Conversation.deleteMany({ correlationId: lead.correlationId });
    await JourneyProcess.deleteMany({ correlationId: lead.correlationId });
    await ProcessedEvent.deleteMany({ correlationId: lead.correlationId });
    log(true, "Cleanup");
  } else {
    log(true, "Kept test data", `lead=${lead._id} correlationId=${lead.correlationId}`);
  }

  if (autoMode && prevAutomation) {
    await updateAutomationSettings(prevAutomation, actor._id);
  } else if (prevAutomation) {
    await updateAutomationSettings(prevAutomation, actor._id);
  }

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
