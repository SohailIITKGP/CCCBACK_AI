/**
 * Single CRM Gmail account — used for outbound (Gmail API) and inbound (Gmail API or IMAP).
 * Set GMAIL_API_USER once; all send/receive paths derive from it.
 */

const DEFAULT_DISPLAY_NAME = "Rewa Realtors CRM";

function extractEmailAddress(raw) {
  const value = String(raw || "").trim();
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim().toLowerCase();
}

function getCrmEmailAddress() {
  return (
    process.env.GMAIL_API_USER ||
    process.env.EMAIL_USER ||
    extractEmailAddress(process.env.EMAIL_FROM) ||
    ""
  )
    .trim()
    .toLowerCase();
}

function getEmailFromHeader() {
  if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
  const email = getCrmEmailAddress();
  if (!email) return null;
  return `"${DEFAULT_DISPLAY_NAME}" <${email}>`;
}

function getImapAuth() {
  const user = process.env.GMAIL_IMAP_USER || getCrmEmailAddress();
  const pass = String(
    process.env.GMAIL_IMAP_PASS || process.env.EMAIL_PASS || ""
  ).replace(/\s+/g, "");
  return { user, pass };
}

function isGmailApiSendEnabled() {
  return String(process.env.EMAIL_SEND_VIA || "auto").toLowerCase() === "gmail_api";
}

function getInboundVia() {
  const explicit = String(process.env.EMAIL_INBOUND_VIA || "").toLowerCase();
  if (explicit === "gmail_api" || explicit === "imap") return explicit;
  if (isGmailApiSendEnabled()) return "gmail_api";
  return "imap";
}

function isInboundEnabled() {
  return String(process.env.GMAIL_INBOUND_ENABLED || "").toLowerCase() === "true";
}

module.exports = {
  DEFAULT_DISPLAY_NAME,
  extractEmailAddress,
  getCrmEmailAddress,
  getEmailFromHeader,
  getImapAuth,
  isGmailApiSendEnabled,
  getInboundVia,
  isInboundEnabled,
};
