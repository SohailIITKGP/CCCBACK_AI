const TEMPLATE_BY_PRIORITY = {
  Hot: "lead_welcome_v1",
  High: "lead_welcome_v1",
  Medium: "lead_followup_v1",
  Cold: "lead_followup_v1",
  Low: "lead_followup_v1",
};

function getTemplateForPriority(priority) {
  return TEMPLATE_BY_PRIORITY[priority] || "lead_followup_v1";
}

module.exports = {
  getTemplateForPriority,
  TEMPLATE_BY_PRIORITY,
};
