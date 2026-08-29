/**
 * Poll Gmail inbox via Gmail API (same OAuth as outbound) for lead/client replies.
 */
const { google } = require("googleapis");
const connectDB = require("../config/db");
const {
  getCrmEmailAddress,
  isInboundEnabled,
} = require("../config/emailAccount");
const {
  processInboundEmail,
  isDuplicateMessage,
  isIgnoredMarketingEmail,
  isLikelyCrmReply,
} = require("./inboundEmailService");
const { getOAuthClient, isGmailApiConfigured } = require("../utils/gmailApiSender");

let pollTimer = null;
let polling = false;

function getPollIntervalMs() {
  const ms = parseInt(process.env.GMAIL_IMAP_POLL_MS || "60000", 10);
  return Math.max(30_000, Math.min(ms, 300_000));
}

async function parseGmailMessage(gmail, id) {
  const { simpleParser } = require("mailparser");
  const res = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "raw",
  });

  if (!res.data?.raw) return null;

  const raw = Buffer.from(res.data.raw, "base64url").toString("utf8");
  const parsed = await simpleParser(raw);

  return { parsed, gmailId: id };
}

async function handleInboundMessage({ parsed, gmailId, crmEmail }) {
  const fromEmail = (parsed.from?.value?.[0]?.address || "").trim().toLowerCase();
  const subject = parsed.subject || "";
  const messageId = parsed.messageId || gmailId;
  const inReplyTo = parsed.inReplyTo || null;
  const references = parsed.references || [];

  if (messageId && (await isDuplicateMessage(messageId))) {
    return { action: "duplicate" };
  }

  if (isIgnoredMarketingEmail(fromEmail, subject)) {
    return { action: "ignore" };
  }

  if (!isLikelyCrmReply({ fromEmail, subject, inReplyTo, references, crmEmail })) {
    const leadExists = await require("../models/Lead").exists({
      email: new RegExp(`^${fromEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      isConverted: { $ne: true },
    });
    if (!leadExists) {
      return { action: "ignore" };
    }
  }

  const result = await processInboundEmail({
    fromEmail,
    subject,
    body: parsed.text || "",
    text: parsed.text || "",
    html: parsed.html || "",
    messageId,
    inReplyTo,
    references,
    source: "gmail_api",
    crmEmail,
  });

  if (result.success) {
    console.log(
      `[gmail-inbound] processed reply from ${fromEmail} → ${result.correlationId} (${result.matchedBy})`
    );
    return { action: "processed", gmailId };
  }

  if (result.skipped) return { action: "skipped" };

  if (result.error === "entity_not_found") {
    if (
      isLikelyCrmReply({ fromEmail, subject, inReplyTo, references, crmEmail })
    ) {
      console.warn(
        `[gmail-inbound] CRM reply not matched — from=${fromEmail} subject="${subject.slice(0, 60)}"`
      );
      return { action: "unmatched_reply" };
    }
    return { action: "no_entity" };
  }

  console.warn("[gmail-inbound] skip message", gmailId, result.error || result.message);
  return { action: "error" };
}

async function markAsRead(gmail, id) {
  try {
    await gmail.users.messages.modify({
      userId: "me",
      id,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });
  } catch (_) {
    /* non-fatal */
  }
}

async function pollOnce() {
  if (polling) return;
  if (!isGmailApiConfigured()) {
    console.error("[gmail-inbound] Gmail API not configured");
    return;
  }

  polling = true;
  const crmEmail = getCrmEmailAddress();

  try {
    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    const list = await gmail.users.messages.list({
      userId: "me",
      labelIds: ["INBOX"],
      q: "newer_than:2d",
      maxResults: 50,
    });

    const ids = (list.data.messages || []).map((m) => m.id).filter(Boolean);
    let processed = 0;
    let unmatched = 0;

    for (const id of ids) {
      const message = await parseGmailMessage(gmail, id);
      if (!message?.parsed) continue;

      const outcome = await handleInboundMessage({
        parsed: message.parsed,
        gmailId: message.gmailId,
        crmEmail,
      });

      if (outcome?.action === "processed") {
        processed += 1;
        await markAsRead(gmail, id);
      }
      if (outcome?.action === "unmatched_reply") unmatched += 1;
    }

    if (processed > 0 || unmatched > 0) {
      console.log(
        `[gmail-inbound] API poll done — processed=${processed} unmatched=${unmatched} scanned=${ids.length}`
      );
    }
  } catch (err) {
    if (/insufficient|scope|403/i.test(err.message)) {
      console.error(
        "[gmail-inbound] Gmail API read failed — re-run node scripts/setupGmailApiAuth.js " +
          "to grant read access, or set EMAIL_INBOUND_VIA=imap with GMAIL_IMAP_PASS"
      );
    } else {
      console.error("[gmail-inbound] API poll error:", err.message);
    }
  } finally {
    polling = false;
  }
}

function startGmailApiInboundPoller() {
  if (!isInboundEnabled()) {
    console.log("[gmail-inbound] disabled (set GMAIL_INBOUND_ENABLED=true)");
    return null;
  }

  if (!isGmailApiConfigured()) {
    console.log("[gmail-inbound] Gmail API OAuth not configured");
    return null;
  }

  const email = getCrmEmailAddress();
  const intervalMs = getPollIntervalMs();
  console.log(
    `[gmail-inbound] Gmail API polling every ${Math.round(intervalMs / 1000)}s (account: ${email || "?"})`
  );

  const run = async () => {
    try {
      await connectDB();
      await pollOnce();
    } catch (err) {
      console.error("[gmail-inbound] run failed:", err.message);
    }
  };

  run();
  pollTimer = setInterval(run, intervalMs);
  return pollTimer;
}

function stopGmailApiInboundPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  startGmailApiInboundPoller,
  stopGmailApiInboundPoller,
  pollOnce,
};
