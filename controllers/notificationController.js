const mongoose = require("mongoose");
const Notification = require("../models/Notification");
const User = require("../models/User");

const ADMIN_ROLES = ["Super Admin", "Manager"];

const isAdmin = (user) => user && ADMIN_ROLES.includes(user.role);

/**
 * Every user — including Super Admin — sees only their own notifications.
 * Legacy global rows (recipientUserId = null) are excluded from the inbox.
 */
const buildVisibilityFilter = (user) => ({
  recipientUserId: user._id,
});

const sanitizePagination = (req) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
};

exports.getNotifications = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { limit, page, skip } = sanitizePagination(req);
    const filter = buildVisibilityFilter(req.user);

    if (req.query.unread === "true") {
      filter.isRead = false;
    }

    if (req.query.category && typeof req.query.category === "string") {
      filter.category = req.query.category;
    }

    const [data, total] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data,
      page,
      limit,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    return res.status(500).json({ error: "Failed to fetch notifications" });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid notification id" });
    }

    const filter = { _id: id, ...buildVisibilityFilter(req.user) };
    const notification = await Notification.findOneAndUpdate(
      filter,
      { $set: { isRead: true, readAt: new Date() } },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }

    return res.status(200).json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    return res.status(500).json({ error: "Failed to mark notification as read" });
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await Notification.updateMany(
      { ...buildVisibilityFilter(req.user), isRead: false },
      { $set: { isRead: true, readAt: new Date() } }
    );

    return res.status(200).json({
      success: true,
      modified: result.modifiedCount || 0,
    });
  } catch (error) {
    console.error("Error marking all notifications as read:", error);
    return res.status(500).json({ error: "Failed to mark notifications as read" });
  }
};

exports.count = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const filter = { isRead: false, ...buildVisibilityFilter(req.user) };
    const count = await Notification.countDocuments(filter);
    return res.status(200).json({ success: true, count });
  } catch (error) {
    console.error("Error counting notifications:", error);
    return res.status(500).json({ error: "Failed to count notifications" });
  }
};

exports.sendNotificationToUser = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!isAdmin(req.user)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { userId, message } = req.body || {};
    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: "Valid userId is required" });
    }
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Message is required" });
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: "Message too long" });
    }

    const targetUser = await User.findById(userId).select("status");
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }
    if (targetUser.status && targetUser.status !== "Active") {
      return res.status(400).json({ error: "Target user is not active" });
    }

    await Notification.create({
      recipientUserId: targetUser._id,
      category: "manual_admin_message",
      type: "User",
      action: "Message",
      entityId: targetUser._id,
      message: message.trim(),
    });

    return res.status(200).json({ success: true, message: "Notification dispatched" });
  } catch (error) {
    console.error("Error sending notification:", error);
    return res.status(500).json({ error: "Failed to send notification" });
  }
};
