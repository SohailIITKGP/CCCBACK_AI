/**
 * One-time backfill for opportunity.reminderState.
 *
 * Why this is needed:
 *   The reminder cron only sweeps opportunities whose `reminderState.status`
 *   is populated. New opportunities and status changes set it automatically,
 *   but every opportunity that existed BEFORE the reminder feature shipped
 *   has reminderState = undefined and is therefore invisible to the cron.
 *
 * What it does:
 *   - For each opportunity with isVisibility = true and no usable
 *     reminderState, seeds reminderState from its current `status`.
 *   - Anchors `statusSetAt` to the last meaningful activity date so we don't
 *     spam a backlog of "missed" reminders (anchor priority below).
 *   - Marks reminderState.completed = true for statuses that aren't tracked
 *     (Win / LOI / Agreement / Reject / etc.) so they're permanently skipped.
 *
 * Anchor priority for statusSetAt (most recent first):
 *   1. The latest commentsSection entry's createdAt (best signal of last activity).
 *   2. opportunity.updatedAt
 *   3. opportunity.createdAt
 *   4. now (fallback)
 *
 * Flags:
 *   --dry-run        Print counts + a small sample, do not write.
 *   --reset-all      Re-seed reminderState even when it already exists.
 *                    (Use only if you've changed the schedule table and want
 *                    to start everyone fresh. Caution.)
 *
 * Usage:
 *   node scripts/backfillReminderState.js --dry-run
 *   node scripts/backfillReminderState.js
 *   node scripts/backfillReminderState.js --reset-all
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

require("../models/User");
require("../models/Client");
require("../models/propertyModel");
const Opportunity = require("../models/Opportunity");
const {
  buildReminderStateForStatus,
} = require("../services/opportunityReminderService");

const parseArgs = () => {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    resetAll: args.includes("--reset-all"),
  };
};

const log = (...parts) => console.log("[backfill]", ...parts);

const pickAnchorDate = (opp) => {
  const comments = Array.isArray(opp.commentsSection) ? opp.commentsSection : [];
  let lastCommentAt = null;
  for (const c of comments) {
    if (c && c.createdAt) {
      const d = new Date(c.createdAt);
      if (!Number.isNaN(d.getTime()) && (!lastCommentAt || d > lastCommentAt)) {
        lastCommentAt = d;
      }
    }
  }
  return lastCommentAt || opp.updatedAt || opp.createdAt || new Date();
};

(async () => {
  const { dryRun, resetAll } = parseArgs();
  await connectDB();

  const filter = { isVisibility: true };
  if (!resetAll) {
    filter.$or = [
      { reminderState: { $exists: false } },
      { "reminderState.status": { $exists: false } },
      { "reminderState.status": null },
    ];
  }

  const total = await Opportunity.countDocuments(filter);
  log(`Found ${total} opportunities to process (resetAll=${resetAll})`);

  const cursor = Opportunity.find(filter).cursor();

  let seededTracked = 0;
  let markedCompleted = 0;
  const trackedSample = [];
  const completedSample = [];

  for await (const opp of cursor) {
    const anchor = pickAnchorDate(opp);
    const state = buildReminderStateForStatus(opp.status, anchor);

    if (state.completed) {
      markedCompleted += 1;
      if (completedSample.length < 5) {
        completedSample.push({ id: opp._id.toString(), status: opp.status });
      }
    } else {
      seededTracked += 1;
      if (trackedSample.length < 5) {
        trackedSample.push({
          id: opp._id.toString(),
          status: opp.status,
          statusSetAt: state.statusSetAt,
          nextReminderAt: state.nextReminderAt,
        });
      }
    }

    if (!dryRun) {
      opp.reminderState = state;
      await opp.save();
    }
  }

  log(`Tracked (will receive reminders): ${seededTracked}`);
  log(`Non-tracked (completed=true): ${markedCompleted}`);
  log("Tracked sample:", trackedSample);
  log("Non-tracked sample:", completedSample);
  log(dryRun ? "DRY RUN – no writes performed." : "Backfill complete.");

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("[backfill] FAILED:", err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
