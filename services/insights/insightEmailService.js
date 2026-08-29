const User = require("../../models/User");
const { sendMailSafe, getEmailFrom } = require("../../utils/smtpTransporter");

const FRONTEND_BASE =
  process.env.CRM_FRONTEND_URL ||
  process.env.FRONTEND_URL ||
  "https://crm.rewarealtors.com";

const isEmailEnabled = () => {
  const flag = (process.env.INSIGHTS_EMAIL_ENABLED || "true").toLowerCase();
  return flag !== "false" && flag !== "0";
};

async function getInsightRecipients() {
  return User.find({
    role: { $in: ["Super Admin", "Manager"] },
    status: "Active",
  })
    .select("email name role")
    .lean();
}

function formatPct(v) {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v}%`;
}

function buildSubject(doc) {
  const score = doc.scores?.efficiencyScore ?? "—";
  const delta = doc.headline?.deltaPct;
  const deltaStr = delta != null ? formatPct(delta) : "—";
  return `CRM Weekly Intelligence — Efficiency ${score}/100 · Conversion ${deltaStr}`;
}

function buildInsightUrl() {
  const base = FRONTEND_BASE.replace(/\/$/, "");
  return `${base}/ai-insights?period=weekly`;
}

function buildHtmlEmail(doc, report) {
  const headline = doc.headline?.sentence || "Weekly operations report";
  const periodLabel = `${doc.meta?.periodStart || ""} → ${doc.meta?.periodEnd || ""}`;
  const insightUrl = buildInsightUrl();
  const score = doc.scores?.efficiencyScore ?? "—";
  const risk = doc.scores?.riskLevel || "—";

  const rootCausesHtml =
    (doc.rootCauses || [])
      .slice(0, 4)
      .map((rc) => {
        let detail = rc.label;
        if (rc.deltaPct != null) detail += ` (${formatPct(rc.deltaPct)})`;
        if (rc.count != null) detail += ` — ${rc.count} leads`;
        return `<li style="margin-bottom:6px;color:#334155;">${detail}</li>`;
      })
      .join("") || "<li>No root causes flagged</li>";

  const affected =
    (doc.mostAffectedEmployees || [])
      .slice(0, 5)
      .map((e) => e.name)
      .join(" · ") || "—";

  const recommendationsHtml =
    (doc.recommendations || [])
      .slice(0, 3)
      .map(
        (r) =>
          `<li style="margin-bottom:8px;"><strong>${r.priority}.</strong> ${r.action}</li>`
      )
      .join("") || "<li>See full report in CRM</li>";

  const summaryHtml =
    (doc.narrative?.executiveSummary || [])
      .slice(0, 3)
      .map((line) => `<li style="margin-bottom:6px;">${line}</li>`)
      .join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Segoe UI,Helvetica,Arial,sans-serif;line-height:1.5;color:#0f172a;background:#f8fafc;padding:24px;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:28px;">
    <h1 style="font-size:20px;margin:0 0 4px;color:#1e3a5f;">AI Operations Intelligence</h1>
    <p style="font-size:13px;color:#64748b;margin:0 0 20px;">${periodLabel}</p>

    <div style="background:#f8fafc;border-radius:8px;padding:16px;margin-bottom:20px;">
      <p style="font-size:16px;font-weight:600;margin:0 0 12px;color:#0f172a;">${headline}</p>
      <p style="font-size:13px;margin:0 0 8px;font-weight:600;color:#64748b;">Because:</p>
      <ul style="margin:0;padding-left:20px;">${rootCausesHtml}</ul>
      <p style="font-size:13px;margin:12px 0 0;"><strong>Most affected:</strong> ${affected}</p>
    </div>

    <table style="width:100%;margin-bottom:20px;font-size:14px;">
      <tr>
        <td style="padding:8px 0;"><strong>Efficiency Score</strong></td>
        <td style="padding:8px 0;text-align:right;font-size:18px;color:#1e3a5f;"><strong>${score}/100</strong></td>
      </tr>
      <tr>
        <td style="padding:8px 0;"><strong>Risk level</strong></td>
        <td style="padding:8px 0;text-align:right;">${risk}</td>
      </tr>
    </table>

    ${summaryHtml ? `<p style="font-size:13px;font-weight:600;color:#64748b;margin:0 0 8px;">Executive summary</p><ul style="margin:0 0 20px;padding-left:20px;font-size:14px;">${summaryHtml}</ul>` : ""}

    <p style="font-size:13px;font-weight:600;color:#64748b;margin:0 0 8px;">Top recommendations</p>
    <ul style="margin:0 0 24px;padding-left:20px;font-size:14px;">${recommendationsHtml}</ul>

    <a href="${insightUrl}" style="display:inline-block;background:#1e3a5f;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;font-size:14px;">View full report in CRM</a>

    <p style="font-size:11px;color:#94a3b8;margin:24px 0 0;">
      Generated ${report.generatedAt ? new Date(report.generatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"} IST · Managers & Super Admin only
    </p>
  </div>
</body>
</html>`;
}

function buildTextEmail(doc, report) {
  const lines = [
    "AI Operations Intelligence",
    `${doc.meta?.periodStart || ""} → ${doc.meta?.periodEnd || ""}`,
    "",
    doc.headline?.sentence || "",
    "",
    "Because:",
  ];

  for (const rc of (doc.rootCauses || []).slice(0, 4)) {
    let line = `- ${rc.label}`;
    if (rc.deltaPct != null) line += ` (${formatPct(rc.deltaPct)})`;
    if (rc.count != null) line += ` — ${rc.count} leads`;
    lines.push(line);
  }

  lines.push(
    "",
    `Most affected: ${(doc.mostAffectedEmployees || []).map((e) => e.name).join(", ") || "—"}`,
    "",
    `Efficiency Score: ${doc.scores?.efficiencyScore ?? "—"}/100`,
    `Risk: ${doc.scores?.riskLevel || "—"}`,
    "",
    "Top recommendations:"
  );

  for (const r of (doc.recommendations || []).slice(0, 3)) {
    lines.push(`${r.priority}. ${r.action}`);
  }

  lines.push("", `Full report: ${buildInsightUrl()}`, "");

  if (doc.narrative?.executiveSummary?.length) {
    lines.push("Executive summary:");
    for (const s of doc.narrative.executiveSummary.slice(0, 3)) {
      lines.push(`- ${s}`);
    }
  }

  return lines.join("\n");
}

/**
 * Send weekly digest to all active Managers and Super Admins.
 */
async function sendInsightDigest(report) {
  if (!isEmailEnabled()) {
    console.log("[insightEmail] Email disabled (INSIGHTS_EMAIL_ENABLED=false)");
    return { sent: false, reason: "disabled", recipientCount: 0 };
  }

  const from = getEmailFrom();
  if (!from) {
    console.warn("[insightEmail] No EMAIL_FROM / SMTP config — skipping digest");
    return { sent: false, reason: "no_smtp", recipientCount: 0 };
  }

  const recipients = await getInsightRecipients();
  const bccList = recipients.map((u) => u.email).filter(Boolean);
  if (bccList.length === 0) {
    console.warn("[insightEmail] No manager/admin recipients found");
    return { sent: false, reason: "no_recipients", recipientCount: 0 };
  }

  const doc = report.document || report;
  const subject = buildSubject(doc);
  const html = buildHtmlEmail(doc, report);
  const text = buildTextEmail(doc, report);

  const result = await sendMailSafe({
    from,
    to: from,
    bcc: bccList,
    subject,
    text,
    html,
  });

  if (result.sent) {
    console.log(
      `[insightEmail] Digest sent to ${bccList.length} recipients (BCC)`
    );
    return { sent: true, recipientCount: bccList.length, messageId: result.messageId };
  }

  console.error("[insightEmail] Digest failed:", result.reason);
  return { sent: false, reason: result.reason || "send_failed", recipientCount: 0 };
}

module.exports = {
  sendInsightDigest,
  getInsightRecipients,
  isEmailEnabled,
  buildInsightUrl,
};
