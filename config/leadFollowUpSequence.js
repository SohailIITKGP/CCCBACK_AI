/**
 * AI lead nurture sequence:
 *   Step 0 — immediate thank-you
 *   Step 1 — details request (~5 min later)
 *   Step 2 — Day 3 nudge
 *   Step 3 — Day 7 final
 * Delays are from lead qualification time (when step 0 is drafted).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function getDetailsRequestDelayMinutes() {
  const mins = parseInt(process.env.LEAD_DETAILS_REQUEST_DELAY_MINUTES || "5", 10);
  return Math.max(1, Math.min(mins, 60));
}

const LEAD_FOLLOW_UP_STEPS = [
  {
    step: 0,
    templateId: "lead_welcome_v1",
    delayDays: 0,
    label: "Welcome — thank you",
  },
  {
    step: 1,
    templateId: "lead_details_request_v1",
    delayMinutes: getDetailsRequestDelayMinutes(),
    label: "Details request",
  },
  {
    step: 2,
    templateId: "lead_followup_day3_v1",
    delayDays: 3,
    label: "Day 3 follow-up",
  },
  {
    step: 3,
    templateId: "lead_followup_day7_v1",
    delayDays: 7,
    label: "Day 7 final follow-up",
  },
];

function getStepConfig(stepIndex) {
  return LEAD_FOLLOW_UP_STEPS.find((s) => s.step === stepIndex) || null;
}

function getDelayMsForStep(stepIndex) {
  const step = getStepConfig(stepIndex);
  if (!step) return null;
  if (step.delayMinutes != null) {
    const mins =
      step.step === 1 ? getDetailsRequestDelayMinutes() : step.delayMinutes;
    return mins * MINUTE_MS;
  }
  return (step.delayDays || 0) * DAY_MS;
}

function isSequenceEnabled() {
  return String(process.env.LEAD_FOLLOWUP_SEQUENCE_ENABLED || "true").toLowerCase() !== "false";
}

module.exports = {
  LEAD_FOLLOW_UP_STEPS,
  DAY_MS,
  MINUTE_MS,
  getDetailsRequestDelayMinutes,
  getStepConfig,
  getDelayMsForStep,
  isSequenceEnabled,
};
