/** Reasons when an employee links a different property than AI suggested. */
const OVERRIDE_REASONS = [
  { id: "client_preference", label: "Client preference" },
  { id: "better_discussion", label: "Better after discussion" },
  { id: "owner_recommendation", label: "Owner recommendation" },
  { id: "relationship", label: "Relationship / network" },
  { id: "availability", label: "Original property unavailable" },
  { id: "other", label: "Other" },
];

const OVERRIDE_REASON_IDS = new Set(OVERRIDE_REASONS.map((r) => r.id));

const SCORE_DELTA_NOTIFY_THRESHOLD = 15;

function isValidOverrideReason(reason) {
  return Boolean(reason && OVERRIDE_REASON_IDS.has(reason));
}

module.exports = {
  OVERRIDE_REASONS,
  OVERRIDE_REASON_IDS,
  SCORE_DELTA_NOTIFY_THRESHOLD,
  isValidOverrideReason,
};
