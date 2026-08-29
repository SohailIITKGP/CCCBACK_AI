const cron = require("node-cron");
const Session = require("../models/Session");
const AuditLog = require("../models/AuditLog");
const User = require("../models/User");
const { runReminderSweep } = require("./opportunityReminderService");
const { runLeadReminderSweep } = require("./leadReminderService");
const {
  getReminderSettings,
  timeToCron,
  recordReminderRun,
} = require("./reminderSettingsService");
const { purgeOldAuditLogs } = require("./auditRetentionService");
const { runScheduledWeeklyInsights } = require("./insights/insightGenerationService");
const { runTodoReminderSweep } = require("./todoReminderService");

let opportunityReminderJob = null;

const runScheduledReminderSweep = async () => {
  try {
    console.log("[scheduledJobs] Running opportunity + lead reminder sweeps…");
    const [oppResult, leadResult] = await Promise.all([
      runReminderSweep(),
      runLeadReminderSweep(),
    ]);
    await recordReminderRun(null, {
      dispatched: (oppResult.dispatched || 0) + (leadResult.dispatched || 0),
      skipped: (oppResult.skipped || 0) + (leadResult.skipped || 0),
      total: (oppResult.total || 0) + (leadResult.total || 0),
    });
    console.log(
      `[scheduledJobs] Sweeps finished. opp=${oppResult.dispatched}/${oppResult.total} lead=${leadResult.dispatched}/${leadResult.total}`
    );
  } catch (error) {
    console.error("[scheduledJobs] Reminder sweep failed:", error);
  }
};

const stopReminderJob = () => {
  if (opportunityReminderJob) {
    opportunityReminderJob.stop();
    opportunityReminderJob = null;
  }
};

const rescheduleReminderJob = async () => {
  stopReminderJob();

  let settings;
  try {
    settings = await getReminderSettings();
  } catch (error) {
    console.error("[scheduledJobs] Could not load reminder settings:", error.message);
    return;
  }

  if (!settings.autoEnabled) {
    console.log(
      "[scheduledJobs] Reminder auto-send is OFF – use the admin dashboard button daily."
    );
    return;
  }

  const dailyTime = settings.dailyTime || "09:00";
  const cronExpr = timeToCron(dailyTime);

  opportunityReminderJob = cron.schedule(cronExpr, runScheduledReminderSweep, {
    scheduled: false,
    timezone: "Asia/Kolkata",
  });
  opportunityReminderJob.start();
  console.log(
    `[scheduledJobs] Reminder auto-send enabled at ${dailyTime} IST (${cronExpr}).`
  );
};

// Auto-logout all users except Admin and Manager at 6:30 PM daily
const autoLogoutJob = cron.schedule(
  "30 18 * * *",
  async () => {
    try {
      console.log("Running scheduled auto-logout at 6:30 PM...");

      const activeSessions = await Session.find({ isActive: true }).populate(
        "userId",
        "role"
      );

      let terminatedCount = 0;

      for (const session of activeSessions) {
        const userRole = session.userId?.role;

        if (userRole === "Super Admin" || userRole === "Manager") {
          continue;
        }

        session.isActive = false;
        session.logoutTime = new Date();
        session.logoutReason = "auto_logout";
        await session.save();

        await AuditLog.log({
          userId: session.userId._id,
          userEmail: session.userId.email || "unknown",
          userRole: userRole || "unknown",
          action: "logout",
          details: {
            sessionId: session._id,
            reason: "Scheduled auto-logout at 6:30 PM",
          },
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          sessionId: session._id,
          status: "success",
        });

        terminatedCount++;
      }

      console.log(`Auto-logout completed. Terminated ${terminatedCount} sessions.`);
    } catch (error) {
      console.error("Error in auto-logout job:", error);
    }
  },
  {
    scheduled: false,
    timezone: "Asia/Kolkata",
  }
);

const cleanupExpiredSessions = cron.schedule(
  "0 * * * *",
  async () => {
    try {
      console.log("Cleaning up expired sessions...");

      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const expiredSessions = await Session.find({
        isActive: true,
        lastActivity: { $lt: oneDayAgo },
      });

      for (const session of expiredSessions) {
        session.isActive = false;
        session.logoutTime = new Date();
        session.logoutReason = "session_expired";
        await session.save();

        await AuditLog.log({
          userId: session.userId,
          userEmail: "system",
          userRole: "system",
          action: "logout",
          details: {
            sessionId: session._id,
            reason: "Session expired (24 hours inactivity)",
          },
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          sessionId: session._id,
          status: "success",
        });
      }

      console.log(`Cleaned up ${expiredSessions.length} expired sessions.`);
    } catch (error) {
      console.error("Error in cleanup job:", error);
    }
  },
  {
    scheduled: false,
    timezone: "Asia/Kolkata",
  }
);

// Weekly AI Operations Intelligence — Monday 08:00 IST
const insightWeeklyJob = cron.schedule(
  process.env.INSIGHTS_WEEKLY_CRON || "0 8 * * 1",
  async () => {
    try {
      console.log("[scheduledJobs] Running weekly AI insights job…");
      await runScheduledWeeklyInsights();
    } catch (error) {
      console.error("[scheduledJobs] Weekly AI insights job failed:", error);
    }
  },
  {
    scheduled: false,
    timezone: "Asia/Kolkata",
  }
);

// Purge audit logs older than AUDIT_LOG_RETENTION_DAYS (default 30)
const auditRetentionJob = cron.schedule(
  "0 3 * * *",
  async () => {
    try {
      await purgeOldAuditLogs();
    } catch (error) {
      console.error("[scheduledJobs] Audit retention purge failed:", error);
    }
  },
  {
    scheduled: false,
    timezone: "Asia/Kolkata",
  }
);

// Monthly intelligence batch — 1st of month at 02:00 IST
const intelligenceBatchJob = cron.schedule(
  "0 2 1 * *",
  async () => {
    try {
      const { runIntelligenceBatch } = require("./intelligenceBatchService");
      const result = await runIntelligenceBatch();
      console.log("[scheduledJobs] Intelligence batch finished:", JSON.stringify(result));
    } catch (error) {
      console.error("[scheduledJobs] Intelligence batch failed:", error.message);
    }
  },
  {
    scheduled: true,
    timezone: "Asia/Kolkata",
  }
);

// Daily exception digest — 09:15 IST (one email per role, not per exception)
const exceptionDigestJob = cron.schedule(
  "15 9 * * *",
  async () => {
    try {
      const { sendDailyExceptionDigest } = require("./exceptionDigestService");
      const result = await sendDailyExceptionDigest();
      console.log("[scheduledJobs] Exception digest finished:", JSON.stringify(result));
    } catch (error) {
      console.error("[scheduledJobs] Exception digest failed:", error.message);
    }
  },
  {
    scheduled: true,
    timezone: "Asia/Kolkata",
  }
);

const todoReminderJob = cron.schedule(
  "*/5 * * * *",
  async () => {
    try {
      const result = await runTodoReminderSweep();
      if (result.reminders || result.overdue || result.occurrences) {
        console.log("[scheduledJobs] To-Do sweep:", JSON.stringify(result));
      }
    } catch (error) {
      console.error("[scheduledJobs] To-Do reminder sweep failed:", error.message);
    }
  },
  {
    scheduled: false,
    timezone: "Asia/Kolkata",
  }
);

module.exports = {
  autoLogoutJob,
  cleanupExpiredSessions,
  rescheduleReminderJob,
  runScheduledReminderSweep,
  auditRetentionJob,
  insightWeeklyJob,
  runScheduledWeeklyInsights,
  intelligenceBatchJob,
  exceptionDigestJob,
  todoReminderJob,
};
