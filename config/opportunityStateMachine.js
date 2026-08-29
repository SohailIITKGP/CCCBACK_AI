/** Status changes that always require human approval — agents may propose, never auto-apply. */
const HUMAN_ONLY_STATUSES = new Set(["Win", "Loss", "Reject"]);

/** Agent may propose these transitions from Pending / early deal stages. */
const AGENT_PROPOSABLE_STATUSES = new Set([
  "Planning for Site Visit",
  "Follow Up",
  "Call",
  "In Evaluation",
]);

const EARLY_DEAL_STATUSES = new Set(["Pending", "In Evaluation", "Follow Up", "Call"]);

function isHumanOnlyStatus(status) {
  return HUMAN_ONLY_STATUSES.has(status);
}

function canAgentProposeStatus(fromStatus, toStatus) {
  if (isHumanOnlyStatus(toStatus)) return false;
  if (!AGENT_PROPOSABLE_STATUSES.has(toStatus)) return false;
  return EARLY_DEAL_STATUSES.has(fromStatus) || fromStatus === "Pending";
}

function assertTransitionAllowed(fromStatus, toStatus, { allowHumanOnly = false } = {}) {
  if (fromStatus === toStatus) return { ok: true };
  if (isHumanOnlyStatus(toStatus) && !allowHumanOnly) {
    return { ok: false, reason: "human_only_status" };
  }
  return { ok: true };
}

module.exports = {
  HUMAN_ONLY_STATUSES,
  AGENT_PROPOSABLE_STATUSES,
  isHumanOnlyStatus,
  canAgentProposeStatus,
  assertTransitionAllowed,
};
