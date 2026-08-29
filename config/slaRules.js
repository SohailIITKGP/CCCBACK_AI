/** SLA thresholds for first contact (hours since lead.created). */
const SLA_HOURS = {
  Hot: 24,
  High: 48,
  Medium: 72,
};

function getSlaHoursForPriority(priority) {
  return SLA_HOURS[priority] || SLA_HOURS.Medium;
}

function isSlaBreached(lead, referenceDate = new Date()) {
  if (!lead?.createdAt) return false;
  const priority = lead.priority || "Medium";
  const limitHours = getSlaHoursForPriority(priority);
  const elapsedMs = referenceDate - new Date(lead.createdAt);
  const elapsedHours = elapsedMs / 3_600_000;
  return elapsedHours > limitHours;
}

module.exports = {
  SLA_HOURS,
  getSlaHoursForPriority,
  isSlaBreached,
};
