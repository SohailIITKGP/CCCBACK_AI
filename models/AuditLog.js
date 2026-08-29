const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false, // Optional for failed login attempts where user doesn't exist yet
      index: true,
    },
    userEmail: {
      type: String,
      required: true,
      index: true,
    },
    userRole: {
      type: String,
      required: true,
      index: true,
    },
    action: {
      type: String,
      required: true,
      enum: [
        "login",
        "logout",
        "login_attempt",
        "login_failed",
        "login_blocked",
        "session_created",
        "session_terminated",
        "password_change",
        "profile_update",
        "data_export",
        "data_create",
        "data_update",
        "data_delete",
        "admin_action",
        "lead_merged",
        "property_override_linked",
        "access_denied",
      ],
      index: true,
    },
    resource: {
      type: String,
      default: "",
    },
    resourceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    details: {
      type: Object,
      default: {},
    },
    ipAddress: {
      type: String,
      required: true,
    },
    userAgent: {
      type: String,
      default: "",
    },
    location: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["success", "failed", "blocked"],
      default: "success",
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
      default: null,
    },
  },
  { timestamps: true }
);

// Indexes for efficient querying
auditLogSchema.index({ userId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ userRole: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ resourceId: 1, createdAt: -1 });
auditLogSchema.index({ resource: 1, resourceId: 1, createdAt: -1 });

// Static method to log an action
auditLogSchema.statics.log = async function (data) {
  try {
    return await this.create(data);
  } catch (error) {
    console.error("Audit log error:", error);
    // Don't throw error - logging should not break the application
    return null;
  }
};

module.exports = mongoose.model("AuditLog", auditLogSchema);

