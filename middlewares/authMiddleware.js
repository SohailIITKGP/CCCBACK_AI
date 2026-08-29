const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Session = require("../models/Session");

const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1]; // Extract the token

  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET); // Decode the token

    // Verify session is active
    const session = await Session.findOne({ token, isActive: true });
    if (!session) {
      return res.status(401).json({ message: "Session expired or invalid. Please login again." });
    }

    // Check if session is expired (24 hours of inactivity)
    if (session.isExpired()) {
      session.isActive = false;
      session.logoutTime = new Date();
      session.logoutReason = "session_expired";
      await session.save();

      return res.status(401).json({ message: "Session expired. Please login again." });
    }

    // Update last activity
    session.lastActivity = new Date();
    await session.save();

    // Get user
    req.user = await User.findById(decoded.id); // Attach user object

    if (!req.user) {
      console.log("User not found in database");
      return res.status(404).json({ message: "User not found" });
    }

    // Check if user is active
    if (req.user.status !== "Active") {
      // Terminate session
      session.isActive = false;
      session.logoutTime = new Date();
      session.logoutReason = "forced";
      await session.save();

      return res.status(403).json({ message: "Your account is inactive. Please contact administrator." });
    }

    // Attach session to request
    req.session = session;

    const { attachAuditLogger } = require("./auditActivityMiddleware");
    attachAuditLogger(req, res);

    next(); // Continue to next middleware
  } catch (error) {
    console.log("Token verification error:", error.message);
    res.status(401).json({ message: "Not authorized, token failed" });
  }
};

module.exports = authMiddleware;
