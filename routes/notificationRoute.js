const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  sendNotificationToUser,
  count,
} = require("../controllers/notificationController");

// All notification endpoints require an authenticated, active session.
// Per-user scoping and admin-only enforcement are handled inside the
// controller methods.
router.use(authMiddleware);

router.get("/", getNotifications);
router.get("/count", count);
router.put("/read-all", markAllAsRead);
router.put("/:id/read", markAsRead);
router.post("/send", sendNotificationToUser);

module.exports = router;
