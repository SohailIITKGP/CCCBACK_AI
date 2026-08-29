const express = require("express");
const { login, logout, changepassword, addDeviceToken } = require("../controllers/authController");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
 
router.post("/login", login);
router.post("/logout", authMiddleware, logout);
router.post("/add-device-token", authMiddleware, addDeviceToken);
router.post("/change-password", authMiddleware, changepassword);

module.exports = router;
