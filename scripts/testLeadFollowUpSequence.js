/**
 * Smoke test for AI lead follow-up sequence (Day 0 / 3 / 7).
 * Run: node scripts/testLeadFollowUpSequence.js
 */
require("dotenv").config();

const connectDB = require("../config/db");
const Lead = require("../models/Lead");
const {
  LEAD_FOLLOW_UP_STEPS,
  getDelayMsForStep,
  isSequenceEnabled,
} = require("../config/leadFollowUpSequence");
const {
  startSequence,
  cancelSequence,
  runScheduledStep,
} = require("../services/leadFollowUpSequenceService");
const { followUpJobId } = require("../queues/followUpQueue");
const { seedCommunicationTemplates } = require("../services/templateService");

function assert(label, condition) {
  const ok = Boolean(condition);
  console.log(ok ? "PASS" : "FAIL", label);
  if (!ok) process.exitCode = 1;
}

async function main() {
  console.log("\n=== Lead follow-up sequence test ===\n");

  assert("sequence enabled by default", isSequenceEnabled());
  assert("4 steps configured", LEAD_FOLLOW_UP_STEPS.length === 4);
  assert("step 0 is welcome", LEAD_FOLLOW_UP_STEPS[0].templateId === "lead_welcome_v1");
  assert("step 1 is details request", LEAD_FOLLOW_UP_STEPS[1].templateId === "lead_details_request_v1");
  assert("step 1 delay is 5 minutes", getDelayMsForStep(1) === 5 * 60 * 1000);
  assert("step 2 delay is 3 days", getDelayMsForStep(2) === 3 * 24 * 60 * 60 * 1000);
  assert("step 3 delay is 7 days", getDelayMsForStep(3) === 7 * 24 * 60 * 60 * 1000);

  if (!process.env.MONGO_URI) {
    console.log("\nSKIP DB tests — MONGO_URI not set\n");
    return;
  }

  await connectDB();
  await seedCommunicationTemplates();

  const tag = `followup-test-${Date.now()}`;
  const lead = await Lead.create({
    name: tag,
    contactPerson: tag,
    email: `test+${Date.now()}@example.com`,
    state: "Mumbai",
    priority: "Medium",
    correlationId: `corr-${tag}`,
    lifecycleState: "QUALIFIED",
  });

  try {
    const started = await startSequence(lead, "test-event");
    assert("sequence starts", started.started === true);
    assert("3 future steps scheduled", started.scheduled === 3);

    const refreshed = await Lead.findById(lead._id).lean();
    assert("aiFollowUpState active", refreshed.aiFollowUpState?.status === "active");

    assert(
      "job id format",
      followUpJobId(lead._id.toString(), 1) === `followup-${lead._id}-step-1`
    );

    const cancelled = await cancelSequence(lead._id, "test_cancel");
    assert("sequence cancels", cancelled.cancelled === true);

    const afterCancel = await Lead.findById(lead._id).lean();
    assert("status cancelled", afterCancel.aiFollowUpState?.status === "cancelled");

    await Lead.findByIdAndUpdate(lead._id, {
      aiFollowUpState: {
        status: "active",
        currentStep: 0,
        stepsCompleted: 1,
        startedAt: new Date(),
      },
    });

    const stepResult = await runScheduledStep({
      leadId: lead._id.toString(),
      stepIndex: 1,
      correlationId: lead.correlationId,
    });
    assert("scheduled step drafts email", stepResult.drafted === true || stepResult.agentActionId);
  } finally {
    await Lead.deleteOne({ _id: lead._id });
  }

  console.log("\nDone.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  });
