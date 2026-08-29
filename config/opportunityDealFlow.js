/** Deal flow timing after opportunity is created. */
const DAY_MS = 24 * 60 * 60 * 1000;

function getProposalFollowUpDelayMs() {
  const days = parseInt(process.env.PROPOSAL_FOLLOWUP_DAYS || "3", 10);
  return Math.max(1, Math.min(days, 14)) * DAY_MS;
}

function getProposalStaleDelayMs() {
  const days = parseInt(process.env.PROPOSAL_STALE_DAYS || "14", 10);
  return Math.max(7, Math.min(days, 30)) * DAY_MS;
}

function getPublicProposalBaseUrl() {
  return (
    process.env.CRM_FRONTEND_URL ||
    process.env.FRONTEND_URL ||
    "https://aicrm.webwonders.co.in"
  ).replace(/\/$/, "");
}

function buildProposalPublicUrl(opportunityId) {
  return `${getPublicProposalBaseUrl()}/proposal/public/${opportunityId}`;
}

module.exports = {
  DAY_MS,
  getProposalFollowUpDelayMs,
  getProposalStaleDelayMs,
  getPublicProposalBaseUrl,
  buildProposalPublicUrl,
};
