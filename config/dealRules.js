const { canAgentProposeStatus } = require("./opportunityStateMachine");

const SITE_VISIT_STATUS = "Planning for Site Visit";
const SITE_VISIT_DAYS_AHEAD = 7;

function shouldProposeSiteVisit(opportunity) {
  if (!opportunity) return false;
  if (opportunity.status !== "Pending") return false;
  if (opportunity.isVisibility === false) return false;
  if (!opportunity.proposalEmailSentAt) return false;
  return canAgentProposeStatus(opportunity.status, SITE_VISIT_STATUS);
}

function getDefaultSiteVisitDate(daysAhead = SITE_VISIT_DAYS_AHEAD) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(11, 0, 0, 0);
  return d;
}

function buildSiteVisitProposal(opportunity) {
  const visitDate = getDefaultSiteVisitDate();
  return {
    proposedStatus: SITE_VISIT_STATUS,
    siteVisitDate: visitDate.toISOString(),
    comment: `AI-proposed site visit for ${opportunity.property?.name || "property"} — please confirm with client.`,
  };
}

module.exports = {
  SITE_VISIT_STATUS,
  shouldProposeSiteVisit,
  getDefaultSiteVisitDate,
  buildSiteVisitProposal,
};
