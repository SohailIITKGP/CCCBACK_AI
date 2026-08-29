const User = require("../models/User");
const { listExceptions } = require("./exceptionCenterService");
const { sendMailSafe, getEmailFrom } = require("../utils/smtpTransporter");

const DIGEST_ROLES = ["Super Admin", "Manager", "Lead-Employee", "FE-Property", "BO-Client"];

function isDigestEnabled() {
  return String(process.env.EXCEPTION_DIGEST_ENABLED || "true").toLowerCase() !== "false";
}

function buildDigestHtml(role, items, overdue) {
  const rows = items
    .slice(0, 15)
    .map(
      (item) =>
        `<li><strong>${item.title}</strong> <span style="color:#64748b">(${item.type.replace(/_/g, " ")})</span>${item.slaDueAt && new Date(item.slaDueAt) < new Date() ? ' <span style="color:#b91c1c">OVERDUE</span>' : ""}</li>`
    )
    .join("");

  return `
    <div style="font-family: Arial, sans-serif; max-width: 640px; padding: 16px;">
      <h2>CRM Exception Digest — ${role}</h2>
      <p>You have <strong>${items.length}</strong> open exception(s)${overdue ? ` (<strong>${overdue}</strong> overdue)` : ""}.</p>
      <ul>${rows}</ul>
      ${items.length > 15 ? `<p>…and ${items.length - 15} more. Open the CRM Exception Center.</p>` : ""}
      <p style="color:#64748b;font-size:12px;">This is one combined digest — not one email per exception.</p>
    </div>`;
}

async function sendDailyExceptionDigest() {
  if (!isDigestEnabled()) {
    return { skipped: true, reason: "digest_disabled" };
  }

  const from = getEmailFrom();
  if (!from) {
    return { skipped: true, reason: "no_smtp" };
  }

  let emailsSent = 0;

  for (const role of DIGEST_ROLES) {
    const { items, overdue } = await listExceptions({
      status: ["open", "assigned"],
      userRole: role,
      limit: 100,
    });

    if (!items.length) continue;

    const users = await User.find({ role, status: "Active", email: { $exists: true, $ne: "" } })
      .select("email name")
      .lean();

    if (!users.length) continue;

    const html = buildDigestHtml(role, items, overdue);
    const subject = `[CRM Digest] ${items.length} open exception${items.length === 1 ? "" : "s"}${overdue ? ` (${overdue} overdue)` : ""}`;

    await Promise.allSettled(
      users.map((user) =>
        sendMailSafe({
          from,
          to: user.email,
          subject,
          html,
        }).then((r) => {
          if (r.sent) emailsSent += 1;
        })
      )
    );
  }

  return { sent: emailsSent };
}

module.exports = {
  sendDailyExceptionDigest,
  isDigestEnabled,
};
