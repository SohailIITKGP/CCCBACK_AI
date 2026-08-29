const User = require("../models/User");
const Session = require("../models/Session");
const AuditLog = require("../models/AuditLog");
const bcrypt = require("bcryptjs");
const { generateToken } = require("../config/jwt");

// Helper function to get client IP
const getClientIP = (req) => {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.headers["x-real-ip"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    "unknown"
  );
};

// Helper function to parse device information from user agent
const parseDeviceInfo = (userAgent) => {
  if (!userAgent) return "Unknown Device";
  
  let deviceInfo = "";
  
  // Detect mobile devices
  if (/Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)) {
    if (/iPhone/i.test(userAgent)) {
      deviceInfo = "iPhone";
    } else if (/iPad/i.test(userAgent)) {
      deviceInfo = "iPad";
    } else if (/Android/i.test(userAgent)) {
      deviceInfo = "Android Mobile";
    } else {
      deviceInfo = "Mobile Device";
    }
  } else {
    // Desktop devices
    if (/Windows/i.test(userAgent)) {
      deviceInfo = "Windows";
    } else if (/Mac/i.test(userAgent)) {
      deviceInfo = "Mac";
    } else if (/Linux/i.test(userAgent)) {
      deviceInfo = "Linux";
    } else {
      deviceInfo = "Desktop";
    }
  }
  
  // Detect browser
  let browser = "";
  if (/Chrome/i.test(userAgent) && !/Edg|OPR/i.test(userAgent)) {
    browser = "Chrome";
  } else if (/Firefox/i.test(userAgent)) {
    browser = "Firefox";
  } else if (/Safari/i.test(userAgent) && !/Chrome/i.test(userAgent)) {
    browser = "Safari";
  } else if (/Edg/i.test(userAgent)) {
    browser = "Edge";
  } else if (/OPR/i.test(userAgent)) {
    browser = "Opera";
  } else {
    browser = "Unknown Browser";
  }
  
  return `${deviceInfo} - ${browser}`;
};

// Helper function to check if login is allowed
// Block login from 8 PM (20:00) to 8 AM (08:00)
// Super Admin and Manager can login anytime
const isLoginTimeAllowed = (userRole = null) => {
  // Super Admin and Manager can login anytime
  if (userRole === "Super Admin" || userRole === "Manager" || userRole === "FE-Property" || userRole === "BO-Client" || userRole === "Lead-Employee" || userRole === "Product-Manager") {
    return true;
  }

  const now = new Date();
  const currentHour = now.getHours();
  const loginStartHour = 8; // 8 AM
  const loginEndHour = 20; // 8 PM

  // Block login between 8 PM (20:00) and 8 AM (08:00)
  // Allow login between 8 AM and 8 PM
  if (currentHour >= loginStartHour && currentHour < loginEndHour) {
    return true;
  }
  
  return false;
};

// Helper function to terminate all active sessions for a user
const terminateAllUserSessions = async (userId, reason = "forced") => {
  try {
    const sessions = await Session.updateMany(
      { userId, isActive: true },
      {
        isActive: false,
        logoutTime: new Date(),
        logoutReason: reason,
      }
    );
    return sessions;
  } catch (error) {
    console.error("Error terminating sessions:", error);
    return null;
  }
};

// Helper function to create new session
const createSession = async (userId, token, req) => {
  try {
    const ipAddress = getClientIP(req);
    const userAgent = req.headers["user-agent"] || "";
    const deviceInfo = parseDeviceInfo(userAgent);

    const session = await Session.create({
      userId,
      token,
      ipAddress,
      userAgent,
      deviceInfo,
      loginTime: new Date(),
      lastActivity: new Date(),
      isActive: true,
    });

    return session;
  } catch (error) {
    console.error("Error creating session:", error);
    return null;
  }
};

exports.addDeviceToken = async (req, res) => {
  try {
    const { deviceToken } = req.body;
    // console.log("deviceToken", deviceToken);
    const user = req.user;
    if (!user.deviceTokens.includes(deviceToken)) {
      user.deviceTokens.push(deviceToken);
      await user.save();
    }
    res.status(200).json({ success: true, message: "Device token added successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.login = async (req, res) => {
  const { email, password, deviceToken } = req.body;
  const ipAddress = getClientIP(req);
  const userAgent = req.headers["user-agent"] || "";

  try {
    if (!email || !password) {
      await AuditLog.log({
        userEmail: email,
        userRole: "unknown",
        action: "login_failed",
        details: { reason: "Missing credentials" },
        ipAddress,
        userAgent,
        status: "failed",
      });

      return res.status(400).json({ message: "Please enter email or password" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      await AuditLog.log({
        userEmail: email,
        userRole: "unknown",
        action: "login_failed",
        details: { reason: "User not found" },
        ipAddress,
        userAgent,
        status: "failed",
      });

      return res.status(404).json({ message: "User not found" });
    }

    if (user.status !== "Active") {
      await AuditLog.log({
        userId: user._id,
        userEmail: user.email,
        userRole: user.role,
        action: "login_blocked",
        details: { reason: "User account is inactive" },
        ipAddress,
        userAgent,
        status: "blocked",
      });

      return res.status(403).json({ message: "Your account is inactive. Please contact administrator." });
    }

    // Check if login time is allowed (8 AM to 8 PM)
    // Super Admin and Manager can login anytime
    if (!isLoginTimeAllowed(user.role)) {
      await AuditLog.log({
        userId: user._id,
        userEmail: user.email,
        userRole: user.role,
        action: "login_blocked",
        details: { reason: "Login time restriction - blocked between 8 PM and 8 AM" },
        ipAddress,
        userAgent,
        status: "blocked",
      });

      return res.status(403).json({
        message: "Login is only allowed between 8:00 AM and 8:00 PM. Please try again during business hours.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      await AuditLog.log({
        userId: user._id,
        userEmail: user.email,
        userRole: user.role,
        action: "login_failed",
        details: { reason: "Invalid password" },
        ipAddress,
        userAgent,
        status: "failed",
      });

      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Enforce single session - terminate all existing active sessions
    await terminateAllUserSessions(user._id, "forced");

    // Generate new token
    const token = generateToken(user._id, user.role);

    // Create new session
    const session = await createSession(user._id, token, req);

    if (!session) {
      return res.status(500).json({ message: "Failed to create session" });
    }

    if (deviceToken && !user.deviceTokens.includes(deviceToken)) {
      user.deviceTokens.push(deviceToken);
      await user.save();
    }

    await AuditLog.log({
      userId: user._id,
      userEmail: user.email,
      userRole: user.role,
      action: "login",
      details: { 
        sessionId: session._id,
        deviceInfo: session.deviceInfo,
        ipAddress: session.ipAddress
      },
      ipAddress,
      userAgent,
      sessionId: session._id,
      status: "success",
    });

    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        name: user.name,
      },
      deviceToken,
      sessionId: session._id,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ success: false, message: error.message || "An error occurred during login" });
  }
};

exports.logout = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    const ipAddress = getClientIP(req);

    if (token) {
      const session = await Session.findOne({ token, isActive: true });
      if (session) {
        session.isActive = false;
        session.logoutTime = new Date();
        session.logoutReason = "manual";
        await session.save();

        await AuditLog.log({
          userId: req.user._id,
          userEmail: req.user.email,
          userRole: req.user.role,
          action: "logout",
          details: { sessionId: session._id },
          ipAddress,
          userAgent: req.headers["user-agent"] || "",
          sessionId: session._id,
          status: "success",
        });
      }
    }

    res.status(200).json({ success: true, message: "Logout successful" });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.changepassword = async (req, res) => {
  const userRole = req.user.role;
  const { email, newPassword } = req.body;
  const ipAddress = getClientIP(req);

  try {
    if (userRole !== "Super Admin") {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    if (!email || !newPassword) {
      return res.status(400).json({ message: "Please enter email and new password" });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const user = await User.findOne({ email: String(email).trim().toLowerCase() });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.password = newPassword;
    await user.save();

    await AuditLog.log({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: "password_change",
      resource: "User",
      resourceId: user._id,
      details: { targetUser: email },
      ipAddress,
      userAgent: req.headers["user-agent"] || "",
      status: "success",
    });

    res.status(200).json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    console.error("Password change error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};
