/**
 * Poll Gmail inbox (IMAP) for lead/client replies and feed the CRM pipeline.
 */
const connectDB = require("../config/db");
const {
  getCrmEmailAddress,
  getImapAuth,
  isInboundEnabled,
} = require("../config/emailAccount");
const {
  processInboundEmail,
  isDuplicateMessage,
  isIgnoredMarketingEmail,
  isLikelyCrmReply,
} = require("./inboundEmailService");

let pollTimer = null;
let polling = false;

function isEnabled() {
  const { user, pass } = getImapAuth();
  return isInboundEnabled() && Boolean(user && pass);
}

function getPollIntervalMs() {
  const ms = parseInt(process.env.GMAIL_IMAP_POLL_MS || "60000", 10);
  return Math.max(30_000, Math.min(ms, 300_000));
}

function getCrmEmail() {
  return getCrmEmailAddress();
}

async function handleMessage(client, uid, crmEmail) {
  const { simpleParser } = require("mailparser");
  const message = await client.fetchOne(uid, { source: true, envelope: true });
  if (!message?.source) return { action: "skip" };

  const parsed = await simpleParser(message.source);
  const fromEmail = (
    parsed.from?.value?.[0]?.address ||
    message.envelope?.from?.[0]?.address ||
    ""
  )
    .trim()
    .toLowerCase();

  const subject = parsed.subject || "";
  const messageId = parsed.messageId || null;
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
    source: "gmail_imap",
    crmEmail,
  });

  if (result.success) {
    await client.messageFlagsAdd(uid, ["\\Seen"]);
    console.log(
      `[gmail-inbound] processed reply from ${fromEmail} → ${result.correlationId} (${result.matchedBy})`
    );
    return { action: "processed" };
  }

  if (result.skipped) {
    return { action: "skipped" };
  }

  if (result.error === "entity_not_found") {
    const likelyReply = isLikelyCrmReply({
      fromEmail,
      subject,
      inReplyTo,
      references,
      crmEmail,
    });
    if (likelyReply) {
      console.warn(
        `[gmail-inbound] CRM reply not matched — from=${fromEmail} subject="${subject.slice(0, 60)}" inReplyTo=${inReplyTo || "none"}`
      );
      return { action: "unmatched_reply" };
    }
    return { action: "no_entity" };
  }

  console.warn("[gmail-inbound] skip uid", uid, result.error || result.message);
  return { action: "error" };
}

async function pollOnce() {
  if (polling) return;
  polling = true;

  try {
    const { ImapFlow } = require("imapflow");
    const crmEmail = getCrmEmail();

    const { user, pass } = getImapAuth();

    const client = new ImapFlow({
      host: process.env.GMAIL_IMAP_HOST || "imap.gmail.com",
      port: parseInt(process.env.GMAIL_IMAP_PORT || "993", 10),
      secure: true,
      auth: { user, pass },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock("INBOX");

    try {
      const unseen = await client.search({ seen: false });
      const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const recent = await client.search({ since });

      const uidSet = new Set([...unseen, ...recent.slice(-50)]);
      const uids = [...uidSet].sort((a, b) => a - b);

      let processed = 0;
      let unmatched = 0;

      for (const uid of uids) {
        const outcome = await handleMessage(client, uid, crmEmail);
        if (outcome?.action === "processed") processed += 1;
        if (outcome?.action === "unmatched_reply") unmatched += 1;
      }

      if (processed > 0 || unmatched > 0) {
        console.log(
          `[gmail-inbound] poll done — processed=${processed} unmatched_replies=${unmatched} scanned=${uids.length}`
        );
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error("[gmail-inbound] poll error:", err.message);
  } finally {
    polling = false;
  }
}

function startGmailInboundPoller() {
  if (!isEnabled()) {
    console.log("[gmail-inbound] disabled (set GMAIL_INBOUND_ENABLED=true + EMAIL_USER/PASS)");
    return null;
  }

  const intervalMs = getPollIntervalMs();
  console.log(`[gmail-inbound] IMAP polling every ${Math.round(intervalMs / 1000)}s (inbox: ${getCrmEmail() || "?"})`);

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

function stopGmailInboundPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  isEnabled,
  startGmailInboundPoller,
  stopGmailInboundPoller,
  pollOnce,
};
