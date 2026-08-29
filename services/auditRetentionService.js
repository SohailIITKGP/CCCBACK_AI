const AuditLog = require("../models/AuditLog");

const DEFAULT_RETENTION_DAYS = 30;

const getRetentionDays = () => {
  const parsed = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
};

const purgeOldAuditLogs = async () => {
  const days = getRetentionDays();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const result = await AuditLog.deleteMany({
    createdAt: { $lt: cutoff },
  });

  console.log(
    `[auditRetention] Purged ${result.deletedCount} audit log(s) older than ${days} days (before ${cutoff.toISOString()})`
  );

  return {
    deletedCount: result.deletedCount,
    retentionDays: days,
    cutoff,
  };
};

module.exports = {
  getRetentionDays,
  purgeOldAuditLogs,
};
