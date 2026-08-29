const Notification = require("../models/Notification");
const User = require("../models/User");

const ADMIN_ROLES = ["Super Admin", "Manager"];

const categoryFromTypeAction = (type, action) =>
  `${String(type || "general").toLowerCase()}_${String(action || "event")
    .toLowerCase()
    .replace(/\s+/g, "_")}`;

/**
 * Create a notification for a specific user.
 */
const createNotificationForUser = async ({
  recipientUserId,
  type,
  action,
  entityId,
  entityName,
  message,
  category,
  severity = "info",
  opportunityId = null,
  meta = {},
}) => {
  if (!recipientUserId) return false;

  const notificationMessage =
    message || `${type} "${entityName || ""}" was ${action}.`.trim();

  try {
    await Notification.create({
      recipientUserId,
      category: category || categoryFromTypeAction(type, action),
      type,
      action,
      entityId,
      entityName,
      message: notificationMessage,
      severity,
      opportunityId,
      meta,
    });
    return true;
  } catch (error) {
    console.error("Error creating notification:", error.message);
    return false;
  }
};

/**
 * Notify active admins/managers when no specific recipient is known.
 * Capped to avoid spam — typically 2–5 users, not 13k globals.
 */
const notifyAdminRoles = async (payload) => {
  try {
    const admins = await User.find({
      role: { $in: ADMIN_ROLES },
      status: "Active",
    })
      .select("_id")
      .lean();

    await Promise.all(
      admins.map((admin) =>
        createNotificationForUser({
          ...payload,
          recipientUserId: admin._id,
        })
      )
    );
    return true;
  } catch (error) {
    console.error("Error notifying admin roles:", error.message);
    return false;
  }
};

/**
 * Backward-compatible signature used across controllers.
 * Always sets recipientUserId — never creates orphan global notifications.
 */
const createNotification = async (
  type,
  action,
  entityId,
  entityName,
  userId = null,
  message = null
) => {
  const payload = {
    type,
    action,
    entityId,
    entityName,
    message,
    category: categoryFromTypeAction(type, action),
  };

  if (userId) {
    return createNotificationForUser({ ...payload, recipientUserId: userId });
  }

  return notifyAdminRoles(payload);
};

module.exports = createNotification;
module.exports.createNotificationForUser = createNotificationForUser;
module.exports.notifyAdminRoles = notifyAdminRoles;
