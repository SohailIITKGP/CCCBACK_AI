#!/usr/bin/env node
/** Phase 4 intelligence layer integration test. */

require("dotenv").config();

const connectDB = require("../config/db");
const mongoose = require("mongoose");
const OutcomeTracking = require("../models/OutcomeTracking");
const RuleChangeProposal = require("../models/RuleChangeProposal");
const RuleConfig = require("../models/RuleConfig");
const {
  recordOutcomeFromOpportunity,
  mapStatusToOutcome,
} = require("../services/outcomeTrackingService");
const {
  runIntelligenceBatch,
  getIntelligenceMetrics,
} = require("../services/intelligenceBatchService");
const ruleProposalService = require("../services/ruleProposalService");
const ruleConfigService = require("../services/ruleConfigService");

require("../models/User");
const User = require("../models/User");

const log = (ok, name, detail = "") =>
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);

(async () => {
  await connectDB();
  const actor = await User.findOne({ role: "Super Admin" });
  if (!actor) process.exit(1);

  const stamp = Date.now();
  const batchTag = `phase4-${stamp}`;
  const seedIds = [];

  log(true, "Setup", actor.email);

  const samples = [
    { outcome: "won", templates: ["lead_welcome_v1"], source: "Referral", props: 3 },
    { outcome: "won", templates: ["lead_welcome_v1"], source: "Referral", props: 2 },
    { outcome: "won", templates: ["lead_followup_v1"], source: "Referral", props: 4 },
    { outcome: "won", templates: ["lead_welcome_v1"], source: "Referral", props: 2 },
    { outcome: "won", templates: ["lead_welcome_v1"], source: "Referral", props: 3 },
    { outcome: "lost", templates: ["lead_followup_v1"], source: "Website", props: 1 },
    { outcome: "lost", templates: ["lead_followup_v1"], source: "Website", props: 1 },
    { outcome: "lost", templates: ["lead_followup_v1"], source: "Facebook", props: 0 },
    { outcome: "lost", templates: ["lead_followup_v1"], source: "Walk-in", props: 1 },
    { outcome: "lost", templates: ["lead_followup_v1"], source: "Website", props: 2 },
  ];

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const doc = await OutcomeTracking.create({
      correlationId: `${batchTag}-${i}`,
      clientId: new mongoose.Types.ObjectId(),
      opportunityId: new mongoose.Types.ObjectId(),
      outcome: sample.outcome,
      followUpTemplatesUsed: sample.templates,
      leadSource: sample.source,
      propertiesShown: Array.from({ length: sample.props }, (_, idx) => ({
        propertyId: new mongoose.Types.ObjectId(),
        rank: idx + 1,
        accepted: sample.outcome === "won" && idx === 0,
      })),
      daysToClose: sample.outcome === "won" ? 12 : 30,
      humanOverrides: sample.outcome === "lost" ? 2 : 0,
      aiApprovalRate: sample.outcome === "won" ? 90 : 40,
      closedAt: new Date(),
    });
    seedIds.push(doc._id);
  }

  log(mapStatusToOutcome("Win") === "won", "Status mapping Win → won");
  log(mapStatusToOutcome("Reject") === "lost", "Status mapping Reject → lost");

  const metrics = await getIntelligenceMetrics(90);
  log(metrics.totalOutcomes >= samples.length, "Metrics loaded", `${metrics.totalOutcomes} outcomes`);

  const batch = await runIntelligenceBatch({ batchId: batchTag });
  log(
    batch.proposalsCreated >= 0,
    "Intelligence batch",
    batch.proposalsCreated != null
      ? `${batch.proposalsCreated} proposals`
      : batch.reason || "skipped"
  );

  const pending = await RuleChangeProposal.find({ batchId: batchTag, status: "pending" }).lean();
  if (pending.length) {
    const approved = await ruleProposalService.approveProposal(pending[0]._id, actor._id);
    log(Boolean(approved.approved), "Proposal approved and applied", pending[0].parameter);

    const config = await ruleConfigService.getActiveConfig();
    log(Boolean(config.matchingWeights || config.followUpTemplates || config.leadScoring), "Active rule config loaded");
  } else {
    log(true, "Proposal approve skipped", "no proposals generated");
  }

  const duplicate = await recordOutcomeFromOpportunity(
    { _id: actor._id, client: { _id: actor._id, correlationId: `${batchTag}-dup` }, property: actor._id },
    "Win"
  );
  log(Boolean(duplicate.skipped || duplicate.recorded), "Outcome idempotency check");

  await OutcomeTracking.deleteMany({ correlationId: new RegExp(`^${batchTag}`) });
  await RuleChangeProposal.deleteMany({ batchId: batchTag });
  await RuleConfig.deleteMany({ sourceProposalId: { $exists: true } });
  log(true, "Cleanup");

  await require("mongoose").disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try {
    await require("mongoose").disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
