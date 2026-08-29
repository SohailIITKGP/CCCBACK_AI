  const cron = require("node-cron");
const mongoose = require("mongoose");
const Opportunity = require("../models/Opportunity");
const User = require("../models/User");
const { sendNotificationToUser } = require("./notificationController");

// cron.schedule("* * * * *", () => {
//   console.log(`[DEBUG] Notification triggered at: ${new Date().toISOString()}`);
// });


const scheduleNotification = (opportunity) => {
  const siteVisitDate = opportunity.commentsSection[0]?.sitevisit?.date;
  if (!siteVisitDate) return; // Prevent scheduling if there's no date

  const notificationTimes = [
    new Date(new Date(siteVisitDate).setHours(20, 0, 0, 0)), // 1 day before 8 PM
    new Date(new Date(siteVisitDate).setHours(22, 0, 0, 0)), // 1 day before 10 PM
    new Date(new Date(siteVisitDate).setHours(7, 0, 0, 0)),  // 7 AM
    new Date(new Date(siteVisitDate).setHours(8, 0, 0, 0)),  // 8 AM
    new Date(new Date(siteVisitDate).setMinutes(siteVisitDate.getMinutes() - 15)) // 15 min before
  ];

  notificationTimes.forEach((notifyTime) => {
    if (isNaN(notifyTime)) return; // Ensure valid date

    // Convert Date → Cron Pattern
    const scheduleTime = `${notifyTime.getMinutes()} ${notifyTime.getHours()} ${notifyTime.getDate()} ${notifyTime.getMonth() + 1} *`;
    // console.log("Scheduled Cron Pattern:", scheduleTime);

    cron.schedule(scheduleTime, async () => {
      try {
        const message = "Reminder: Upcoming site visit or follow-up!";
        const userIds = [
          opportunity.commentsSection[0]?.whoCommented,
          opportunity.whoLinkthis,
          opportunity.property?.whoCreated,
          ...await getAdminsAndManagers()          
        ];

        // console.log("Notifying Users:", userIds);
        for (const userId of userIds) {
          await sendNotificationToUser({ userId, message });
        }
      } catch (error) {
        console.error("Error sending scheduled notification:", error);
      }
    });
  });
};

const getAdminsAndManagers = async () => {
  try {
    const adminsAndManagers = await User.find({ role: { $in: ["Super Admin", "Manager"] } });
    return adminsAndManagers.map(user => user._id);
  } catch (error) {
    console.error("Error fetching admins and managers:", error);
    return [];
  }
};

// Fetch opportunities and schedule notifications
const scheduleNotificationsForOpportunities = async () => {
  const opportunities = await Opportunity.find({});
  opportunities.forEach(scheduleNotification);
};

scheduleNotificationsForOpportunities();
