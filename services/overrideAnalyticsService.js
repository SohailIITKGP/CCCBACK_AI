const DomainEvent = require("../models/DomainEvent");
const AuditLog = require("../models/AuditLog");
const { DAY_MS } = require("../config/opportunityDealFlow");
const { OVERRIDE_REASONS } = require("../config/propertyOverride");

async function getOverrideAnalytics({ days = 90 } = {}) {
  const since = new Date(Date.now() - days * DAY_MS);

  const events = await DomainEvent.find({
    eventType: "property.override_linked",
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .lean();

  const byReason = {};
  const scoreDeltas = [];
  let withAiScore = 0;

  for (const event of events) {
    const reason = event.payload?.overrideReason || "unknown";
    byReason[reason] = (byReason[reason] || 0) + 1;

    const aiScore = event.payload?.aiScore;
    const newScore = event.payload?.newPropertyScore;
    if (typeof aiScore === "number" && typeof newScore === "number") {
      withAiScore += 1;
      scoreDeltas.push(aiScore - newScore);
    }
  }

  const avgScoreDelta =
    scoreDeltas.length > 0
      ? Math.round((scoreDeltas.reduce((a, b) => a + b, 0) / scoreDeltas.length) * 10) / 10
      : null;

  const auditCount = await AuditLog.countDocuments({
    action: { $in: ["property_override_linked", "data_update"] },
    "details.action": "property_override_linked",
    createdAt: { $gte: since },
  });

  const reasonLabels = Object.fromEntries(OVERRIDE_REASONS.map((r) => [r.id, r.label]));

  const recent = events.slice(0, 20).map((e) => ({
    at: e.createdAt,
    overrideReason: e.payload?.overrideReason,
    overrideLabel: reasonLabels[e.payload?.overrideReason] || e.payload?.overrideReason,
    aiScore: e.payload?.aiScore,
    newPropertyScore: e.payload?.newPropertyScore,
    scoreDelta:
      typeof e.payload?.aiScore === "number" && typeof e.payload?.newPropertyScore === "number"
        ? e.payload.aiScore - e.payload.newPropertyScore
        : null,
    clientId: e.payload?.clientId,
    previousPropertyId: e.payload?.previousPropertyId,
    newPropertyId: e.payload?.newPropertyId,
    correlationId: e.correlationId,
  }));

  return {
    periodDays: days,
    since,
    totalOverrides: events.length,
    auditLogEntries: auditCount,
    byReason: Object.entries(byReason)
      .map(([reason, count]) => ({
        reason,
        label: reasonLabels[reason] || reason,
        count,
      }))
      .sort((a, b) => b.count - a.count),
    avgScoreDelta,
    overridesWithScoreComparison: withAiScore,
    recent,
  };
}

module.exports = {
  getOverrideAnalytics,
};
