const { getSmtpTransporter, getEmailFrom, sendMailSafe } = require("./smtpTransporter");

const sendEmailAsync = async (mailOptions) => {
  const result = await sendMailSafe({
    from: mailOptions.from || getEmailFrom(),
    ...mailOptions,
  });
  if (result.sent) {
    console.log("Email sent successfully:", result.messageId);
  }
  return result.sent;
};

const sendQuickNotification = (recipients, subject, message) => {
  if (!recipients || recipients.length === 0) return;

  sendMailSafe({
    from: getEmailFrom(),
    to: recipients.join(", "),
    subject,
    html: message,
  }).catch((err) => console.error("Email service error:", err.message));
};

module.exports = {
  sendEmailAsync,
  sendQuickNotification,
  getSmtpTransporter,
  sendMailSafe,
  getEmailFrom,
};
