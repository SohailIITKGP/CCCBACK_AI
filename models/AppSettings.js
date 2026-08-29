const mongoose = require("mongoose");

const reminderSettingsSchema = new mongoose.Schema(
  {
    /** Daily send time in 24h HH:mm, Asia/Kolkata */
    dailyTime: { type: String, default: "09:00" },
    /** When false, reminders only go out via admin dashboard button */
    autoEnabled: { type: Boolean, default: false },
    lastRunAt: { type: Date, default: null },
    lastRunBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastRunResult: {
      dispatched: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
  },
  { _id: false }
);

const appSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "app" },
    reminders: { type: reminderSettingsSchema, default: () => ({}) },
  },
  { timestamps: true }
);

appSettingsSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findById("app");
  if (!doc) {
    doc = await this.create({ _id: "app" });
  }
  return doc;
};

module.exports = mongoose.model("AppSettings", appSettingsSchema);
