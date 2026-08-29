const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    // Who should see this notification in the web app. Null = global/system-wide
    // (kept for backward compatibility with existing global notifications).
    recipientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    // Functional grouping (e.g. "opportunity_reminder", "lead_created").
    category: {
      type: String,
      default: "general",
      index: true,
    },

    // Domain object the notification refers to.
    type: { type: String, required: true }, // Lead, Client, Property, Opportunity, User
    action: { type: String, required: true }, // Created, Updated, Reminder, Deleted, ...
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    entityName: { type: String },

    // Optional direct opportunity link – avoids extra lookups on the frontend.
    opportunityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Opportunity",
      default: null,
      index: true,
    },

    message: { type: String, required: true },
    severity: {
      type: String,
      enum: ["info", "warning", "critical"],
      default: "info",
    },

    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date },

    // Free-form metadata (status, reminderNumber, etc.) – never echo this back
    // to clients other than the recipient.
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Common access pattern: latest unread for a given user.
notificationSchema.index({ recipientUserId: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
