const express = require("express");
const dotenv = require("dotenv");
const connectDB = require("./config/db");
const { apiLimiter, createLimiter } = require("./middlewares/rateLimiter");
const leadRoutes = require("./routes/leadRoutes");
const clientRoutes = require("./routes/clientRoutes");
const userRoutes = require("./routes/userRoutes");
const authRoutes = require("./routes/authRoutes");
const sessionRoutes = require("./routes/sessionRoutes");
const errorHandler = require("./middlewares/errorHandler");
const proppertyRoutes = require("./routes/propertyRoutes");
const linkRoutes = require("./routes/linkRoutes");
const opportunityRoutes = require("./routes/opportunityRoutes");
const taskRoutes = require("./routes/taskRoutes");
const notificationRoutes = require("./routes/notificationRoute");
const trackRoutes = require("./routes/trackRoutes");
// Legacy push-notification cron module – disabled. It depends on Firebase
// (now removed) and registered broken cron jobs at boot. Kept on disk for
// reference; do NOT re-enable without rewriting it.
// const checkpushnotificaion = require("./controllers/checkpushnotificaion");
const chatbotRoutes = require("./routes/chatbotRoutes");
const reportRoutes = require("./routes/reportRoutes");
const proposalRoutes = require("./routes/ProposalRoutes");
const recommendationRoutes = require("./routes/recommendation");
const followUpTaskRoutes = require("./routes/followUpTaskRoutes");
const todoRoutes = require("./routes/todoRoutes");
const teamRoutes = require("./routes/teamRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const insightRoutes = require("./routes/insightRoutes");
const eventRoutes = require("./routes/eventRoutes");
const agentRoutes = require("./routes/agentRoutes");
const journeyRoutes = require("./routes/journeyRoutes");
const channelRoutes = require("./routes/channelRoutes");
const intelligenceRoutes = require("./routes/intelligenceRoutes");
const exceptionRoutes = require("./routes/exceptionRoutes");
const activityRoutes = require("./routes/activityRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const {
  autoLogoutJob,
  cleanupExpiredSessions,
  rescheduleReminderJob,
  auditRetentionJob,
  insightWeeklyJob,
  todoReminderJob,
} = require("./services/scheduledJobs");
const cors = require("cors"); 
const path = require("path");

dotenv.config();

const isVercel = Boolean(process.env.VERCEL);

if (!isVercel) {
  autoLogoutJob.start();
  cleanupExpiredSessions.start();
  auditRetentionJob.start();
  insightWeeklyJob.start();
  todoReminderJob.start();
  connectDB().then(() => {
    rescheduleReminderJob().catch((err) =>
      console.error("[app] Failed to schedule reminder job:", err.message)
    );
  });
}

const app = express();

// CORS first — preflight must succeed before DB/rate-limit middleware.
const corsOptions = {
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "Rewa Realtors CRM API",
    env: isVercel ? "vercel" : "server",
  });
});

app.get("/api/health", async (_req, res) => {
  try {
    await connectDB();
    const mongoose = require("mongoose");
    res.status(200).json({
      ok: true,
      mongo: mongoose.connection.readyState === 1 ? "connected" : "connecting",
    });
  } catch (err) {
    res.status(503).json({
      ok: false,
      mongo: "disconnected",
      error: err.message,
    });
  }
});

app.use(async (req, res, next) => {
  if (req.method === "OPTIONS") return next();
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("[app] DB middleware:", err.message);
    return res.status(503).json({
      success: false,
      message: "Database unavailable. Check MONGO_URI on Vercel.",
    });
  }
});

// Apply rate limiting
app.use(apiLimiter);

app.use(express.json({ limit: '10mb' })); // Limit JSON payload size
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Limit URL-encoded payload size

// Add debugging middleware for static files
app.use((req, res, next) => {
  // console.log('Static file request:', req.url);
  next();
});

// Use absolute paths for static directories
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/public", express.static(path.join(__dirname, "public")));

// Routes with specific rate limiting
app.use("/api/auth", authRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/users", userRoutes);
app.use("/api/properties", proppertyRoutes);
app.use("/api/link", linkRoutes);
app.use("/api/opportunities", opportunityRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/track", trackRoutes);
app.use("/api", taskRoutes);
// app.use("/api", checkpushnotificaion);
app.use("/api/chat", chatbotRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/proposal", proposalRoutes);
app.use("/api/recommend", recommendationRoutes);
app.use("/api/follow-up-tasks", followUpTaskRoutes);
app.use("/api/todos", todoRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/insights", insightRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/journey", journeyRoutes);
app.use("/api/channels", channelRoutes);
app.use("/api/intelligence", intelligenceRoutes);
app.use("/api/exceptions", exceptionRoutes);
app.use("/api/activities", activityRoutes);
app.use("/api/analytics", analyticsRoutes);
// Error Handler    
app.use(errorHandler);

module.exports = app;
