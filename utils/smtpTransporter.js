const nodemailer = require("nodemailer");
const { getEmailFromHeader, getCrmEmailAddress, getImapAuth } = require("../config/emailAccount");
const {
  isGmailApiConfigured,
  verifyGmailApiConnection,
  sendViaGmailApi,
} = require("./gmailApiSender");

const EMAIL_SEND_TIMEOUT_MS = parseInt(
  process.env.EMAIL_SEND_TIMEOUT_MS || "45000",
  10
);

let cachedTransporter = null;
let cachedTransporterKey = "";

const withTimeout = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });

function getSmtpAuth() {
  const { user, pass } = getImapAuth();
  return { user: user || getCrmEmailAddress(), pass };
}

function getSmtpHostConfig() {
  const auth = getSmtpAuth();
  const host = process.env.EMAIL_SMTP_HOST || "smtp.gmail.com";
  const port = parseInt(process.env.EMAIL_SMTP_PORT || "465", 10);
  const secure =
    (process.env.EMAIL_SMTP_SECURE || "").toLowerCase() === "true" ||
    port === 465;

  return { host, port, secure, user: auth.user, pass: auth.pass };
}

function buildTransporterKey(cfg) {
  return `${cfg.host}:${cfg.port}:${cfg.secure}:${cfg.user}`;
}

function createTransporter(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
    pool: true,
    maxConnections: 2,
    maxMessages: 30,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 45_000,
    family: 4,
    tls: {
      minVersion: "TLSv1.2",
      servername: cfg.host,
    },
  });
}

const getSmtpTransporter = (overrides = {}) => {
  const base = getSmtpHostConfig();
  const cfg = {
    ...base,
    host: overrides.host || base.host,
    port: overrides.port ?? base.port,
    secure: overrides.secure ?? base.secure,
  };
  const key = buildTransporterKey(cfg);
  if (cachedTransporter && cachedTransporterKey === key) {
    return cachedTransporter;
  }

  if (!cfg.user || !cfg.pass) {
    console.warn("[smtp] EMAIL_USER / EMAIL_PASS not set – email disabled.");
    return null;
  }

  cachedTransporter = createTransporter(cfg);
  cachedTransporterKey = key;
  return cachedTransporter;
};

function getGmailFallbackConfigs(primary) {
  if (!primary.host.includes("gmail.com")) return [];
  if (primary.port === 465) return [{ port: 587, secure: false }];
  if (primary.port === 587) return [{ port: 465, secure: true }];
  return [];
}

async function verifySmtpWithConfig(cfg, overrides = {}) {
  const host = overrides.host || cfg.host;
  const port = overrides.port ?? cfg.port;
  const secure = overrides.secure ?? (port === 465);
  const transporter = getSmtpTransporter({ host, port, secure });
  await withTimeout(transporter.verify(), EMAIL_SEND_TIMEOUT_MS, "smtp.verify");
  return { ok: true, host, port, secure, user: cfg.user };
}

const getEmailFrom = () => getEmailFromHeader();

const sendMailSafe = async (mailOptions) => {
  const from = mailOptions.from || getEmailFrom();
  const payload = { ...mailOptions, from };
  const sendVia = String(process.env.EMAIL_SEND_VIA || "auto").toLowerCase();
  const fallbackEnabled =
    String(process.env.GMAIL_API_FALLBACK || "true").toLowerCase() !== "false";

  if (sendVia === "gmail_api") {
    if (!isGmailApiConfigured()) {
      return { sent: false, reason: "gmail_api_not_configured" };
    }
    return sendViaGmailApi(payload);
  }

  if (sendVia === "gmail_api_only") {
    return isGmailApiConfigured()
      ? sendViaGmailApi(payload)
      : { sent: false, reason: "gmail_api_not_configured" };
  }

  const transporter = getSmtpTransporter();
  if (!transporter) {
    if (isGmailApiConfigured()) {
      return sendViaGmailApi(payload);
    }
    return { sent: false, reason: "no_config" };
  }

  try {
    const info = await withTimeout(
      transporter.sendMail({
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      }),
      EMAIL_SEND_TIMEOUT_MS,
      "sendMail"
    );
    return { sent: true, messageId: info.messageId, via: "smtp" };
  } catch (err) {
    console.error("[smtp] send failed:", err.message);
    if (fallbackEnabled && isGmailApiConfigured()) {
      console.warn("[email] SMTP failed, retrying via Gmail API (HTTPS)…");
      const apiResult = await sendViaGmailApi(payload);
      if (apiResult.sent) return apiResult;
      return { sent: false, reason: apiResult.reason || err.message };
    }
    return { sent: false, reason: err.message, via: "smtp" };
  }
};

function getSmtpConfigSummary() {
  const cfg = getSmtpHostConfig();
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    configured: Boolean(cfg.user && cfg.pass),
  };
}

/** Verify email transport at startup. Prefers Gmail API when configured for cloud VPS. */
async function verifySmtpConnection() {
  if (String(process.env.SMTP_VERIFY_ON_START || "true").toLowerCase() === "false") {
    console.log("[smtp] startup check disabled (SMTP_VERIFY_ON_START=false)");
    return { ok: true, skipped: true, reason: "disabled" };
  }

  const sendVia = String(process.env.EMAIL_SEND_VIA || "auto").toLowerCase();
  if (sendVia === "gmail_api" || sendVia === "gmail_api_only") {
    return verifyGmailApiConnection();
  }

  if (isGmailApiConfigured() && sendVia === "auto") {
    const apiCheck = await verifyGmailApiConnection();
    if (apiCheck.ok) {
      console.log("[email] using Gmail API for outbound (works from cloud VPS; SMTP may still be used locally)");
      return apiCheck;
    }
  }

  const baseCfg = getSmtpHostConfig();
  if (!baseCfg.user || !baseCfg.pass) {
    if (isGmailApiConfigured()) {
      return verifyGmailApiConnection();
    }
    console.warn("[smtp] startup check skipped — EMAIL_USER / EMAIL_PASS not set");
    return { ok: false, skipped: true, reason: "no_config" };
  }

  try {
    const result = await verifySmtpWithConfig(baseCfg);
    console.log(
      `[smtp] startup check OK — ${result.host}:${result.port} (${result.secure ? "SSL" : "STARTTLS"}) as ${result.user}`
    );
    return { ok: true, ...result, via: "smtp" };
  } catch (err) {
    console.error(
      `[smtp] startup check FAILED — ${baseCfg.host}:${baseCfg.port} as ${baseCfg.user}: ${err.message}`
    );

    for (const fb of getGmailFallbackConfigs(baseCfg)) {
      try {
        console.warn(`[smtp] retrying on port ${fb.port}…`);
        cachedTransporter = null;
        cachedTransporterKey = "";
        const result = await verifySmtpWithConfig(baseCfg, fb);
        console.log(
          `[smtp] startup check OK — ${result.host}:${result.port} (${result.secure ? "SSL" : "STARTTLS"}) as ${result.user}`
        );
        return { ok: true, ...result, via: "smtp" };
      } catch (retryErr) {
        console.error(`[smtp] port ${fb.port} also failed: ${retryErr.message}`);
      }
    }

    if (isGmailApiConfigured()) {
      console.warn("[email] SMTP unreachable from this host — falling back to Gmail API check");
      const apiCheck = await verifyGmailApiConnection();
      if (apiCheck.ok) return apiCheck;
    }

    console.error(
      "[email] outbound email will fail until SMTP works or Gmail API credentials are set (see scripts/setupGmailApiAuth.js)"
    );
    return { ok: false, reason: err.message, ...baseCfg };
  }
}

module.exports = {
  getSmtpTransporter,
  getEmailFrom,
  getSmtpConfigSummary,
  verifySmtpConnection,
  sendMailSafe,
  withTimeout,
  EMAIL_SEND_TIMEOUT_MS,
};
