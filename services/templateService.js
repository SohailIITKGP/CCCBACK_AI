const CommunicationTemplate = require("../models/CommunicationTemplate");

const ALLOWED_GLOBAL_VARS = new Set([
  "clientName",
  "contactPerson",
  "preferredArea",
  "city",
  "agentName",
  "personalizedLine",
  "nextStepDate",
  "propertyName",
  "propertyList",
  "matchCount",
  "proposalLink",
  "proposalPropertyName",
  "proposalBlock",
  "expectedRent",
  "area",
]);

const DETAILS_ASK_BLOCK = `To help you better, please reply with:

• City
• Preferred area / locality
• Required size (sqft)
• Budget / expected rent
• Type of business (warehouse, office, retail, etc.)`;

const DEFAULT_TEMPLATES = [
  {
    templateId: "lead_welcome_v1",
    channel: "email",
    purpose: "Immediate thank-you after lead created (no details ask yet)",
    subject: "Thank you for reaching out, {{clientName}}",
    body: `Hi {{clientName}},\n\nThank you for contacting Rewa Realtors. We received your enquiry and our team will contact you shortly.\n\n{{personalizedLine}}\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: ["clientName", "personalizedLine", "city"],
  },
  {
    templateId: "lead_details_request_v1",
    channel: "email",
    purpose: "Follow-up (~5 min) — ask for requirement details before client conversion",
    subject: "Please share your property requirements, {{clientName}}",
    body: `Hi {{clientName}},\n\nThank you for your interest in Rewa Realtors.\n\n${DETAILS_ASK_BLOCK}\n\n{{personalizedLine}}\n\nOnce we have these details, we will register you as a client and then share matching property options.\n\nReply to this email with the details above.\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: ["clientName", "personalizedLine", "city"],
  },
  {
    templateId: "lead_followup_v1",
    channel: "email",
    purpose: "Standard follow-up",
    subject: "Following up on your property requirement",
    body: `Hi {{clientName}},\n\nWe wanted to follow up regarding your commercial property requirement.\n\n{{personalizedLine}}\n\nPlease reply if you would like to schedule a call or site visit.\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: ["clientName", "personalizedLine", "city"],
  },
  {
    templateId: "lead_followup_day3_v1",
    channel: "email",
    purpose: "Day 3 nurture — remind lead to share details",
    subject: "Quick reminder — share your property requirement",
    body: `Hi {{clientName}},\n\nJust checking in on your commercial property enquiry.\n\n${DETAILS_ASK_BLOCK}\n\n{{personalizedLine}}\n\nReply to this email with the details above.\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: ["clientName", "personalizedLine", "city"],
  },
  {
    templateId: "lead_followup_day7_v1",
    channel: "email",
    purpose: "Day 7 final nurture — ask for details",
    subject: "Still interested? Share your property requirement",
    body: `Hi {{clientName}},\n\nWe wanted to follow up one last time on your commercial property enquiry.\n\n${DETAILS_ASK_BLOCK}\n\n{{personalizedLine}}\n\nIf your plans have changed, simply reply and let us know.\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: ["clientName", "personalizedLine", "city"],
  },
  {
    templateId: "lead_request_details_v1",
    channel: "email",
    purpose: "Ask lead to share missing requirements after reply",
    subject: "Please share your property requirements",
    body: `Hi {{clientName}},\n\nThank you for your reply.\n\n${DETAILS_ASK_BLOCK}\n\n{{personalizedLine}}\n\nReply to this email with the details and we will take you to the next step.\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: ["clientName", "personalizedLine", "city"],
  },
  {
    templateId: "lead_conversion_ack_v1",
    channel: "email",
    purpose: "Confirm requirements received after successful parse",
    subject: "We received your requirements — matching properties",
    body: `Hi {{clientName}},\n\nThank you — we received your property requirements:\n\n{{personalizedLine}}\n\nOur team is now matching suitable properties for you. We will share options shortly.\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: ["clientName", "personalizedLine", "city"],
  },
  {
    templateId: "client_properties_share_v1",
    channel: "email",
    purpose: "Share matched property shortlist with client",
    subject: "{{matchCount}} property options for you — {{city}}",
    body: `Hi {{clientName}},\n\nGood news — we found {{matchCount}} commercial properties that match your requirement.\n\n{{personalizedLine}}\n\n{{propertyList}}\n\n{{proposalBlock}}\nReply to this email with the option number(s) you like, or ask us to schedule a site visit / call.\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: [
      "clientName",
      "personalizedLine",
      "city",
      "matchCount",
      "propertyList",
      "proposalLink",
      "proposalPropertyName",
      "proposalBlock",
    ],
  },
  {
    templateId: "client_proposal_share_v1",
    channel: "email",
    purpose: "Share property proposal link after opportunity is created",
    subject: "Proposal — {{propertyName}} @ {{city}}",
    body: `Hi {{clientName}},\n\nThank you for your interest. Please review the proposal for {{propertyName}} in {{city}}:\n\n{{proposalLink}}\n\nExpected rent: {{expectedRent}}\nArea: {{area}}\n\nOpen the link to view photos, floor plans, and full details. Reply to this email if you have questions or would like to schedule a site visit.\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: [
      "clientName",
      "propertyName",
      "city",
      "proposalLink",
      "expectedRent",
      "area",
    ],
  },
  {
    templateId: "proposal_followup_v1",
    channel: "email",
    purpose: "SLA reminder when client has not opened the proposal",
    subject: "Reminder — proposal for {{propertyName}}",
    body: `Hi {{clientName}},\n\nWe shared a property proposal for {{propertyName}} in {{city}} a few days ago.\n\nPlease review it when you have a moment:\n{{proposalLink}}\n\nIf you would like a site visit or have questions, reply to this email.\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: ["clientName", "propertyName", "city", "proposalLink"],
  },
  {
    templateId: "client_no_match_v1",
    channel: "email",
    purpose: "No inventory match — reassure client while team sources options",
    subject: "Update on your property search — {{city}}",
    body: `Hi {{clientName}},\n\nThank you for your patience.\n\nWe are actively sourcing commercial properties that match your requirements in {{city}}. Our property team will contact you within 24 hours with suitable options.\n\nIf your requirements have changed, simply reply to this email.\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: ["clientName", "city"],
  },
  {
    templateId: "client_reply_ack_v1",
    channel: "email",
    purpose: "Acknowledge client email reply while team acts",
    subject: "We received your message",
    body: `Hi {{clientName}},\n\nThank you for your reply. Our team has received your message and will get back to you shortly.\n\nBest regards,\nRewa Realtors Team`,
    allowedVariables: ["clientName"],
  },
];

async function seedCommunicationTemplates() {
  for (const tpl of DEFAULT_TEMPLATES) {
    await CommunicationTemplate.updateOne(
      { templateId: tpl.templateId },
      { $set: tpl },
      { upsert: true }
    );
  }
}

async function getTemplate(templateId) {
  return CommunicationTemplate.findOne({ templateId, isActive: true }).lean();
}

function sanitizeVariables(variables, allowedVariables) {
  const allowed = new Set(allowedVariables || []);
  const safe = {};
  for (const [key, value] of Object.entries(variables || {})) {
    if (!allowed.has(key) || !ALLOWED_GLOBAL_VARS.has(key)) continue;
    const maxLen = key === "propertyList" ? 5000 : 500;
    safe[key] = String(value).slice(0, maxLen);
  }
  return safe;
}

function renderTemplate(template, variables) {
  const safeVars = sanitizeVariables(variables, template.allowedVariables);
  const replace = (text) =>
    String(text).replace(/\{\{(\w+)\}\}/g, (_, key) => safeVars[key] || "");

  return {
    subject: replace(template.subject),
    body: replace(template.body),
    variables: safeVars,
  };
}

module.exports = {
  seedCommunicationTemplates,
  getTemplate,
  renderTemplate,
  sanitizeVariables,
  ALLOWED_GLOBAL_VARS,
};
