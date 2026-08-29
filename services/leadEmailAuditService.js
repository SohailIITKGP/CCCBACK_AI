const { logAutomationEvent } = require("../utils/auditLogger");

function formatRequirementsSummary(parsed) {
  return [
    parsed.city && `City: ${parsed.city}`,
    parsed.preferredArea && `Area: ${parsed.preferredArea}`,
    parsed.minimumArea && `Size: ${parsed.minimumArea} sqft`,
    parsed.expectedRent && `Budget: ${parsed.expectedRent}`,
    parsed.kindOfBusiness && `Business: ${parsed.kindOfBusiness}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

async function logEmailSent({ entityType, entityId, entityName, toEmail, subject, templateId }) {
  return logAutomationEvent({
    action: "data_update",
    resource: entityType,
    resourceId: entityId,
    entityName,
    details: {
      action: "email_sent",
      toEmail,
      subject: String(subject || "").slice(0, 200),
      templateId: templateId || null,
    },
  });
}

async function logEmailReplyReceived({
  entityType,
  entityId,
  entityName,
  fromEmail,
  subject,
  parsed,
  complete,
}) {
  const summary = formatRequirementsSummary(parsed);
  return logAutomationEvent({
    action: "data_update",
    resource: entityType,
    resourceId: entityId,
    entityName,
    details: {
      action: "email_reply_received",
      fromEmail,
      subject: String(subject || "").slice(0, 200),
      requirementsSummary: summary || null,
      requirementsComplete: Boolean(complete),
      parsed: parsed
        ? {
            city: parsed.city,
            preferredArea: parsed.preferredArea,
            minimumArea: parsed.minimumArea,
            expectedRent: parsed.expectedRent,
            kindOfBusiness: parsed.kindOfBusiness,
          }
        : null,
    },
  });
}

async function logRemarksUpdatedFromEmail({
  entityId,
  entityName,
  previousRemarks,
  newRemarks,
  parsed,
}) {
  return logAutomationEvent({
    action: "data_update",
    resource: "Lead",
    resourceId: entityId,
    entityName,
    details: {
      action: "email_requirements_in_remarks",
      changeType: "field_change",
      field: "remarks",
      from: String(previousRemarks || "").slice(0, 300) || "—",
      to: String(newRemarks || "").slice(0, 300) || "—",
      requirementsSummary: formatRequirementsSummary(parsed),
    },
  });
}

module.exports = {
  formatRequirementsSummary,
  logEmailSent,
  logEmailReplyReceived,
  logRemarksUpdatedFromEmail,
};
