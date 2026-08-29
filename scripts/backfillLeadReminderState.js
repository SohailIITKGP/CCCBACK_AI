/**
 * One-time backfill: seed reminderState for existing leads on nurturing statuses.
 *
 * Usage: node scripts/backfillLeadReminderState.js
 */

require("dotenv").config();
const connectDB = require("../config/db");
const Lead = require("../models/Lead");
const {
  LEAD_REMINDER_SCHEDULES,
  buildReminderStateForStatus,
  isLeadReminderTrackedStatus,
} = require("../services/leadReminderService");
const { regenerateLeadReminderScheduleTasks } = require("../services/followUpTaskService");

const TRACKED = Object.keys(LEAD_REMINDER_SCHEDULES);

async function main() {
  await connectDB();

  const leads = await Lead.find({
    isConverted: { $ne: true },
    status: { $in: TRACKED },
  });

  let updated = 0;
  let tasks = 0;

  for (const lead of leads) {
    if (!isLeadReminderTrackedStatus(lead.status)) continue;

    const anchor = lead.updatedAt || lead.createdAt || new Date();
    lead.reminderState = buildReminderStateForStatus(lead.status, anchor);
    await lead.save();
    updated += 1;

    const result = await regenerateLeadReminderScheduleTasks(lead);
    tasks += (result.created || 0) + (result.updated || 0);
  }

  console.log(`Backfill complete. leads=${updated} taskSlots=${tasks}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
