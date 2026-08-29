const { google } = require("googleapis");

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SCOPES = [GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE];

const { getCrmEmailAddress } = require("../config/emailAccount");

let cachedAuth = null;

function isGmailApiConfigured() {
  return Boolean(
    process.env.GMAIL_CLIENT_ID &&
      process.env.GMAIL_CLIENT_SECRET &&
      process.env.GMAIL_REFRESH_TOKEN
  );
}

function getOAuthClient() {
  if (!isGmailApiConfigured()) return null;

  if (cachedAuth) return cachedAuth;

  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
  });
  cachedAuth = client;
  return client;
}

function encodeSubject(subject) {
  const value = String(subject || "");
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

function buildMimeMessage({ from, to, subject, text, html }) {
  const lines = [`From: ${from}`, `To: ${to}`, `Subject: ${encodeSubject(subject)}`];

  if (html && text) {
    const boundary = `crm_${Date.now()}`;
    lines.push("MIME-Version: 1.0");
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(text);
    lines.push(`--${boundary}`);
    lines.push("Content-Type: text/html; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(html);
    lines.push(`--${boundary}--`);
  } else if (html) {
    lines.push("MIME-Version: 1.0");
    lines.push("Content-Type: text/html; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(html);
  } else {
    lines.push("MIME-Version: 1.0");
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(text || "");
  }

  return lines.join("\r\n");
}

function encodeRawMessage(mime) {
  return Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function verifyGmailApiConnection() {
  if (!isGmailApiConfigured()) {
    return { ok: false, skipped: true, reason: "no_config" };
  }

  const auth = getOAuthClient();
  try {
    const token = await auth.getAccessToken();
    if (!token?.token) {
      return { ok: false, reason: "no_access_token" };
    }
    const user = getCrmEmailAddress() || "me";
    console.log(`[gmail-api] startup check OK — send enabled as ${user}`);
    return { ok: true, user, via: "gmail_api" };
  } catch (err) {
    console.error("[gmail-api] startup check FAILED:", err.message);
    return { ok: false, reason: err.message, via: "gmail_api" };
  }
}

async function sendViaGmailApi(mailOptions) {
  const auth = getOAuthClient();
  if (!auth) {
    return { sent: false, reason: "gmail_api_not_configured" };
  }

  const from = mailOptions.from || require("../config/emailAccount").getEmailFromHeader();
  const to = mailOptions.to;
  if (!from || !to) {
    return { sent: false, reason: "missing_from_or_to" };
  }

  try {
    const gmail = google.gmail({ version: "v1", auth });
    const raw = encodeRawMessage(
      buildMimeMessage({
        from,
        to,
        subject: mailOptions.subject,
        text: mailOptions.text,
        html: mailOptions.html,
      })
    );

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    let messageId = res.data.id;
    let threadId = res.data.threadId;

    try {
      const meta = await gmail.users.messages.get({
        userId: "me",
        id: res.data.id,
        format: "metadata",
        metadataHeaders: ["Message-ID", "Message-Id"],
      });
      const headers = meta.data.payload?.headers || [];
      const rfcId = headers.find((h) => h.name?.toLowerCase() === "message-id")?.value;
      if (rfcId) messageId = rfcId;
    } catch (_) {
      /* keep Gmail internal id as fallback */
    }

    return {
      sent: true,
      messageId,
      gmailId: res.data.id,
      threadId,
      via: "gmail_api",
    };
  } catch (err) {
    console.error("[gmail-api] send failed:", err.message);
    return { sent: false, reason: err.message, via: "gmail_api" };
  }
}

module.exports = {
  isGmailApiConfigured,
  verifyGmailApiConnection,
  sendViaGmailApi,
  getOAuthClient,
  GMAIL_SEND_SCOPE,
  GMAIL_READ_SCOPE,
  GMAIL_SCOPES,
};
