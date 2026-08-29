/**
 * Backfill FollowUpTask timing fields for existing rows.
 * Does NOT fabricate completedAt/startedAt — marks timing unavailable when missing.
 *
 * Usage:
 *   node cccback/scripts/migrateFollowUpTaskTiming.js
 *   node cccback/scripts/migrateFollowUpTaskTiming.js --dry-run
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const FollowUpTask = require("../models/FollowUpTask");
const { computeCompletionFields } = require("../utils/taskTiming");

const DRY = process.argv.includes("--dry-run");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGO_URI missing");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log("Connected", DRY ? "(dry-run)" : "");

  const cursor = FollowUpTask.find({
    $or: [
      { originalDueAt: { $exists: false } },
      { originalDueAt: null },
      { timingDataAvailable: { $exists: false } },
      { completionTiming: { $exists: false } },
    ],
  }).cursor();

  let scanned = 0;
  let updated = 0;

  for await (const task of cursor) {
    scanned += 1;
    const patch = {};
    if (!task.originalDueAt && task.dueDate) {
      patch.originalDueAt = task.dueDate;
    }
    if (task.rescheduledCount == null) patch.rescheduledCount = 0;
    if (!Array.isArray(task.rescheduleHistory)) patch.rescheduleHistory = [];

    if (task.status === "Completed") {
      if (!task.completedAt) {
        patch.timingDataAvailable = false;
        patch.completionTiming = "unknown";
      } else {
        const fields = computeCompletionFields(task, task.completedAt);
        patch.completionTiming = fields.completionTiming;
        patch.timingDataAvailable = fields.timingDataAvailable;
        if (fields.actualDurationMs != null && task.actualDurationMs == null) {
          patch.actualDurationMs = fields.actualDurationMs;
        }
      }
    } else if (task.timingDataAvailable == null) {
      patch.timingDataAvailable = true;
    }

    if (Object.keys(patch).length === 0) continue;
    updated += 1;
    if (!DRY) {
      await FollowUpTask.updateOne({ _id: task._id }, { $set: patch });
    }
  }

  console.log({ scanned, updated, dryRun: DRY });
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
