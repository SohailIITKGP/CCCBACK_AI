/** Exception types, default owners, SLA hours. */
const EXCEPTION_TYPES = {
  no_property_match: {
    label: "No property match",
    ownerRole: "FE-Property",
    severity: "high",
    slaHours: 24,
  },
  client_intent_review: {
    label: "Client reply — needs review",
    ownerRole: "Manager",
    severity: "medium",
    slaHours: 8,
  },
  property_unavailable: {
    label: "Property unavailable",
    ownerRole: "FE-Property",
    severity: "high",
    slaHours: 12,
  },
  property_price_changed: {
    label: "Rent/price changed — budget mismatch",
    ownerRole: "Manager",
    severity: "medium",
    slaHours: 24,
  },
  property_deleted: {
    label: "Property deleted — affected deals",
    ownerRole: "Manager",
    severity: "high",
    slaHours: 4,
  },
  manual_override: {
    label: "Manual property override",
    ownerRole: "Manager",
    severity: "low",
    slaHours: 48,
  },
  proposal_stale: {
    label: "Proposal not opened",
    ownerRole: "Lead-Employee",
    severity: "medium",
    slaHours: 72,
  },
  proposal_stale: {
    label: "Proposal not opened",
    ownerRole: "Lead-Employee",
    severity: "medium",
    slaHours: 24,
  },
  lead_nurture_exhausted: {
    label: "Lead nurture exhausted — no reply",
    ownerRole: "Lead-Employee",
    severity: "medium",
    slaHours: 48,
  },
  duplicate_lead: {
    label: "Duplicate lead detected",
    ownerRole: "Manager",
    severity: "medium",
    slaHours: 24,
  },
  smtp_failure: {
    label: "Email delivery failed",
    ownerRole: "Manager",
    severity: "high",
    slaHours: 4,
  },
  ai_low_confidence: {
    label: "AI low confidence",
    ownerRole: "Manager",
    severity: "medium",
    slaHours: 8,
  },
};

function getExceptionConfig(type) {
  return EXCEPTION_TYPES[type] || {
    label: type,
    ownerRole: "Manager",
    severity: "medium",
    slaHours: 24,
  };
}

module.exports = {
  EXCEPTION_TYPES,
  getExceptionConfig,
};
