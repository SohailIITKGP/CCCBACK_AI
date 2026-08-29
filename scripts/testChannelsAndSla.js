#!/usr/bin/env node
/** Test Phase 3.2 SLA + Phase 3.3 channels. Run: node scripts/testChannelsAndSla.js */

require("dotenv").config();

const connectDB = require("../config/db");
const leadFacade = require("../facades/leadFacade");
const { runInlineOrchestration } = require("../services/orchestrationTestHarness");
const { emitSlaBreachedIfNeeded, handleSlaBreached } = require("../agents/handlers/slaMonitorHandler");
const conversationService = require("../services/conversationService");
const { isAiPaused } = require("../services/aiPauseService");
const JourneyProcess = require("../models/JourneyProcess");

require("../models/User");
const User = require("../models/User");
const Lead = require("../models/Lead");
const OutboxEvent = require("../models/OutboxEvent");
const DomainEvent = require("../models/DomainEvent");
const Conversation = require("../models/Conversation");

const log = (ok, name, detail = "") =>
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);

(async () => {
  await connectDB();
  const actor = await User.findOne({ role: "Super Admin" });
  if (!actor) process.exit(1);

  const stamp = Date.now();
  log(true, "Setup", actor.email);

  const lead = await leadFacade.createLead(
    {
      name: `Channel SLA Test ${stamp}`,
      contactNumber: `5555${String(stamp).slice(-6)}`,
      email: `channel-${stamp}@example.com`,
      priority: "Hot",
    },
    { type: "user", userId: actor._id }
  );

  await Lead.findByIdAndUpdate(lead._id, {
    createdAt: new Date(Date.now() - 48 * 3600 * 1000),
  });
  const staleLead = await Lead.findById(lead._id).lean();

  const breach = await emitSlaBreachedIfNeeded(staleLead, {
    eventId: `test-sla-${stamp}`,
    eventType: "sla.test",
  });
  log(Boolean(breach.breached), "SLA breach emitted");

  await runInlineOrchestration(lead.correlationId, 4);

  const breachOutbox = await OutboxEvent.findOne({
    correlationId: lead.correlationId,
    eventType: "sla.breached",
  }).lean();
  log(Boolean(breachOutbox), "sla.breached outbox");

  const paused = await isAiPaused(lead.correlationId);
  log(paused, "AI paused after sla.breached");

  await conversationService.recordInboundReply({
    correlationId: lead.correlationId,
    entityType: "Lead",
    entityId: lead._id,
    channel: "email",
    content: "Thanks, please send more options.",
    subject: "Re: warehouse inquiry",
    externalMessageId: `test-${stamp}`,
    actor: lead.email,
  });

  await runInlineOrchestration(lead.correlationId, 3);

  const conv = await Conversation.findOne({ correlationId: lead.correlationId }).lean();
  log(conv?.channels?.length >= 1, "Conversation thread", `${conv?.channels?.length || 0} messages`);

  const replied = await DomainEvent.findOne({
    correlationId: lead.correlationId,
    eventType: "message.replied",
  }).lean();
  log(Boolean(replied), "message.replied event");

  await Lead.deleteOne({ _id: lead._id });
  await OutboxEvent.deleteMany({ correlationId: lead.correlationId });
  await DomainEvent.deleteMany({ correlationId: lead.correlationId });
  await Conversation.deleteMany({ correlationId: lead.correlationId });
  await JourneyProcess.deleteMany({ correlationId: lead.correlationId });
  log(true, "Cleanup");

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
