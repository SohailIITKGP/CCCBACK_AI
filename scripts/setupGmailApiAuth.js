/**
 * One-time setup: obtain GMAIL_REFRESH_TOKEN for Gmail API send (HTTPS, works on DigitalOcean).
 *
 * 1. Google Cloud Console → APIs & Services → Enable "Gmail API"
 * 2. Create OAuth 2.0 Client ID (Desktop app)
 * 3. Add redirect URI: http://localhost:3333/oauth2callback
 * 4. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env
 * 5. Run: node scripts/setupGmailApiAuth.js
 */
require("dotenv").config();
const http = require("http");
const { URL } = require("url");
const { google } = require("googleapis");
const { GMAIL_SCOPES } = require("../utils/gmailApiSender");

const REDIRECT_URI = process.env.GMAIL_OAUTH_REDIRECT || "http://localhost:3333/oauth2callback";
const PORT = parseInt(process.env.GMAIL_OAUTH_PORT || "3333", 10);

async function main() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.");
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
  });

  const crmEmail = process.env.GMAIL_API_USER || process.env.EMAIL_USER || "your CRM Gmail";
  console.log("\nOpen this URL and sign in as:", crmEmail, "\n");
  console.log(authUrl);
  console.log("\nWaiting for OAuth callback on", REDIRECT_URI, "…\n");

  const code = await waitForAuthCode();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.error(
      "No refresh_token returned. Revoke app access at https://myaccount.google.com/permissions and run again with prompt=consent."
    );
    process.exit(1);
  }

  console.log("\nAdd these to your .env (local + DigitalOcean server):\n");
  console.log(`GMAIL_CLIENT_ID=${clientId}`);
  console.log(`GMAIL_CLIENT_SECRET=${clientSecret}`);
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log("GMAIL_API_USER=nishantk1103@gmail.com");
  console.log('EMAIL_FROM="Rewa Realtors CRM <nishantk1103@gmail.com>"');
  console.log("EMAIL_SEND_VIA=gmail_api");
  console.log("EMAIL_INBOUND_VIA=gmail_api");
  console.log("GMAIL_INBOUND_ENABLED=true");
  console.log("\nThen: pm2 restart crm-api crm-worker\n");
}

function waitForAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        if (url.pathname !== "/oauth2callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const err = url.searchParams.get("error");
        if (err) {
          res.writeHead(400);
          res.end(`OAuth error: ${err}`);
          server.close();
          reject(new Error(err));
          return;
        }

        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400);
          res.end("Missing code");
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorized</h1><p>You can close this tab and return to the terminal.</p>");
        server.close();
        resolve(code);
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Listening on http://127.0.0.1:${PORT} for OAuth callback…`);
    });
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
