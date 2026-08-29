/**
 * Manual test harness for the opportunity reminder pipeline.
 *
 * What it does:
 *   1. Loads ONE opportunity (by --id, or the most recent visible one).
 *   2. Optionally sets its status to a target status (--status "In Evaluation").
 *   3. Backdates reminderState.statusSetAt + nextReminderAt so the next
 *      reminder is due RIGHT NOW.
 *   4. Runs a single reminder sweep.
 *   5. Prints the Notification documents created for that opportunity.
 *
 * Usage:
 *   node scripts/testOpportunityReminder.js                  # most recent opp, current status
 *   node scripts/testOpportunityReminder.js --id <ObjectId>
 *   node scripts/testOpportunityReminder.js --status "In Evaluation"
 *   node scripts/testOpportunityReminder.js --id <ObjectId> --status "Pending"
 *
 * Safety:
 *   - This script never deletes data, only mutates one opportunity's
 *     `reminderState` and (optionally) its `status`.
 *   - Designed to be run against a dev / staging database. Do NOT point it
 *     at production unless you know which opportunity you're touching.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

// IMPORTANT: load every model the reminder service populates / queries BEFORE
// requiring the service itself. The service runs .populate("client", ...) and
// .populate("property", ...), which fail with MissingSchemaError unless those
// schemas have been registered with Mongoose first.
require("../models/User");
require("../models/Client");
require("../models/propertyModel");

const Opportunity = require("../models/Opportunity");
const Notification = require("../models/Notification");
const {
  REMINDER_SCHEDULES,
  buildReminderStateForStatus,
  runReminderSweep,
} = require("../services/opportunityReminderService");

const parseArgs = () => {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === "--id") out.id = args[++i];
    else if (key === "--status") out.status = args[++i];
  }
  return out;
};

const log = (...parts) => console.log("[reminder-test]", ...parts);

(async () => {
  const { id, status } = parseArgs();
  await connectDB();

  let opp;
  if (id) {
    if (!mongoose.isValidObjectId(id)) {
      console.error("Invalid --id provided.");
      process.exit(1);
    }
    opp = await Opportunity.findById(id);
  } else {
    opp = await Opportunity.findOne({ isVisibility: true }).sort({ createdAt: -1 });
  }

  if (!opp) {
    console.error("No opportunity found. Pass --id <ObjectId> or seed data first.");
    process.exit(1);
  }

  log("Target opportunity:", opp._id.toString(), "current status:", opp.status);

  if (status) {
    if (!REMINDER_SCHEDULES[status]) {
      log(
        `WARN: "${status}" is not a tracked reminder status. Tracked statuses are:`
      );
      log("  " + Object.keys(REMINDER_SCHEDULES).join("\n  "));
    }
    opp.status = status;
    opp.reminderState = buildReminderStateForStatus(status);
    log(`Set status -> "${status}", reset reminderState`);
  } else if (!opp.reminderState || !opp.reminderState.status) {
    opp.reminderState = buildReminderStateForStatus(opp.status);
    log("Bootstrapped reminderState from current status");
  }

  // Force the next reminder to fire right now.
  const now = new Date();
  if (opp.reminderState && !opp.reminderState.completed) {
    opp.reminderState.statusSetAt = new Date(now.getTime() - 1000);
    opp.reminderState.nextReminderAt = new Date(now.getTime() - 1000);
  }

  await opp.save();
  log("reminderState after backdate:", opp.reminderState);

  log("Running sweep...");
  const result = await runReminderSweep();
  log("Sweep result:", result);

  const recentNotifications = await Notification.find({
    opportunityId: opp._id,
    category: "opportunity_reminder",
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  log(`Found ${recentNotifications.length} reminder notification(s) for this opp:`);
  for (const n of recentNotifications) {
    log("  -", n.createdAt.toISOString(), "→", n.recipientUserId, "::", n.message);
  }

  const refreshed = await Opportunity.findById(opp._id).lean();
  log("reminderState after sweep:", refreshed.reminderState);

  await mongoose.disconnect();
  log("Done.");
})().catch(async (err) => {
  console.error("[reminder-test] FAILED:", err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
