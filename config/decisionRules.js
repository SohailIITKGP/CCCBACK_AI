const URGENCY_KEYWORDS = ["urgent", "immediate", "asap", "today", "tomorrow"];
const WAREHOUSE_KEYWORDS = ["warehouse", "sqft", "sq ft", "industrial", "logistics"];

const DEFAULT_SCORING_BONUSES = {
  urgencyKeyword: 30,
  warehouseKeyword: 15,
  referralSource: 20,
  linkedinSource: 10,
  hasEmail: 5,
  hasPhone: 5,
  hotPriority: 25,
  highPriority: 15,
  freshLead: 10,
};

function computeLeadPriorityScore(lead, bonuses = DEFAULT_SCORING_BONUSES) {
  let score = 0;
  const remarks = String(lead.remarks || "").toLowerCase();
  const source = String(lead.sourceOfConnection || "").toLowerCase();

  if (URGENCY_KEYWORDS.some((k) => remarks.includes(k))) score += bonuses.urgencyKeyword;
  if (WAREHOUSE_KEYWORDS.some((k) => remarks.includes(k))) score += bonuses.warehouseKeyword;
  if (source.includes("referral")) score += bonuses.referralSource;
  if (source.includes("linkedin")) score += bonuses.linkedinSource;
  if (lead.email) score += bonuses.hasEmail;
  if (lead.contactNumber) score += bonuses.hasPhone;
  if (lead.priority === "Hot") score += bonuses.hotPriority;
  if (lead.priority === "High") score += bonuses.highPriority;

  const ageHours =
    (Date.now() - new Date(lead.createdAt || Date.now()).getTime()) / 3_600_000;
  if (ageHours < 24) score += bonuses.freshLead;

  return score;
}

function scoreToPriority(score) {
  if (score >= 70) return "Hot";
  if (score >= 50) return "High";
  if (score >= 30) return "Medium";
  if (score >= 15) return "Cold";
  return "Low";
}

function computeLeadPriority(lead, bonuses = DEFAULT_SCORING_BONUSES) {
  const score = computeLeadPriorityScore(lead, bonuses);
  return {
    priority: scoreToPriority(score),
    score,
    reasoning: `Rule score ${score} from remarks, source, and contact completeness`,
  };
}

function shouldQualifyLead(lead) {
  if (lead.isConverted) return false;
  if (["CONVERTED", "LOST"].includes(lead.lifecycleState)) return false;
  return Boolean(lead.name && (lead.email || lead.contactNumber));
}

module.exports = {
  computeLeadPriority,
  computeLeadPriorityScore,
  shouldQualifyLead,
  DEFAULT_SCORING_BONUSES,
};
