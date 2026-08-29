/**
 * Admin dashboard funnel stage rules (aligned with Pipeline + Opportunities list).
 */

const { PIPELINE_STATUSES } = require("./opportunityPipelineList");

/** Opportunities list filter: commentsSection.tag === "Site Visit Done" */
const SITE_VISIT_DONE_COMMENT_TAG = "Site Visit Done";

const SITE_VISIT_DONE_STATUSES = [
  "Site Visit Done",
  "Site Visit Done - Looks Positive",
];

const LOI_STATUSES = ["LOI", "Loi Received", "Loi Singed"];

const AGREEMENT_STATUS = "Agreement";

function firstCommentWithTags(opp, tags) {
  if (!Array.isArray(opp?.commentsSection)) return false;
  return opp.commentsSection.some((c) => tags.includes(c.tag));
}

/** Reached site visit done: exact comment tag (list filter) or current status. */
function hasSiteVisitDone(opp) {
  if (SITE_VISIT_DONE_STATUSES.includes(opp?.status)) return true;
  if (!Array.isArray(opp?.commentsSection)) return false;
  return opp.commentsSection.some((c) => c.tag === SITE_VISIT_DONE_COMMENT_TAG);
}

/** Reached LOI: current LOI-family status, LOA details saved, or LOI comment tag. */
function hasLoiSign(opp) {
  if (LOI_STATUSES.includes(opp?.status)) return true;
  if (opp?.loaDetails?.dateOfLOI || opp?.loaDetails?.whenCreated) return true;
  return firstCommentWithTags(opp, LOI_STATUSES);
}

/** Reached agreement: current status or agreement details / comment. */
function hasAgreement(opp) {
  if (opp?.status === AGREEMENT_STATUS) return true;
  if (opp?.agreementDetails?.date || opp?.agreementDetails?.whenCreated) return true;
  return firstCommentWithTags(opp, [AGREEMENT_STATUS]);
}

/** Same as Pipeline page: visible + current status in pipeline list. */
function hasPipeline(opp) {
  if (opp?.isVisibility === false) return false;
  return !!(opp?.status && PIPELINE_STATUSES.includes(opp.status));
}

function countOpportunityStages(opportunities) {
  const totalOpportunities = opportunities.length;
  let opportunityToPipeline = 0;
  let opportunityToSiteVisitDone = 0;
  let siteVisitDoneCount = 0;
  let siteVisitDoneToLoi = 0;
  let loiSignCount = 0;
  let loiToAgreement = 0;

  for (const opp of opportunities) {
    const inPipeline = hasPipeline(opp);
    const siteVisit = hasSiteVisitDone(opp);
    const loi = hasLoiSign(opp);
    const agreement = hasAgreement(opp);

    if (inPipeline) opportunityToPipeline += 1;
    if (siteVisit) {
      opportunityToSiteVisitDone += 1;
      siteVisitDoneCount += 1;
      if (loi) siteVisitDoneToLoi += 1;
    }
    if (loi) {
      loiSignCount += 1;
      if (agreement) loiToAgreement += 1;
    }
  }

  return {
    totalOpportunities,
    opportunityToPipeline,
    opportunityToSiteVisitDone,
    siteVisitDoneCount,
    siteVisitDoneToLoi,
    loiSignCount,
    loiToAgreement,
  };
}

module.exports = {
  PIPELINE_STATUSES,
  SITE_VISIT_DONE_COMMENT_TAG,
  SITE_VISIT_DONE_STATUSES,
  LOI_STATUSES,
  hasPipeline,
  hasSiteVisitDone,
  hasLoiSign,
  hasAgreement,
  countOpportunityStages,
};
