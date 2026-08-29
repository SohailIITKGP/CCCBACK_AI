/**
 * Start inbound email polling — Gmail API (default when EMAIL_SEND_VIA=gmail_api) or IMAP fallback.
 */
const { getInboundVia, getCrmEmailAddress, isInboundEnabled } = require("../config/emailAccount");
const { isGmailApiConfigured } = require("../utils/gmailApiSender");

function startInboundPoller() {
  if (!isInboundEnabled()) {
    console.log("[gmail-inbound] disabled (GMAIL_INBOUND_ENABLED=false)");
    return null;
  }

  const via = getInboundVia();
  const account = getCrmEmailAddress();

  if (via === "gmail_api" && isGmailApiConfigured()) {
    const { startGmailApiInboundPoller } = require("./gmailInboundApiPollerService");
    console.log(`[email] inbound via Gmail API — ${account || "OAuth account"}`);
    return startGmailApiInboundPoller();
  }

  const { startGmailInboundPoller } = require("./gmailInboundPollerService");
  console.log(`[email] inbound via IMAP — ${account || "?"}`);
  return startGmailInboundPoller();
}

function stopInboundPoller() {
  try {
    require("./gmailInboundApiPollerService").stopGmailApiInboundPoller();
  } catch (_) {
    /* ignore */
  }
  try {
    require("./gmailInboundPollerService").stopGmailInboundPoller();
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  startInboundPoller,
  stopInboundPoller,
};
