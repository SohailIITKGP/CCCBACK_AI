/**
 * Real inboxes for CRM email / reply testing.
 * Override with TEST_LEAD_EMAIL (single) or comma-separated TEST_LEAD_EMAILS in .env
 */

const DEFAULT_TEST_EMAILS = [
  "nishuk7898@gmail.com",
  "nishu757898@gmail.com",
  "kk.possible.it.is@gmail.com",
  "nishantkumawat@kgpian.iitkgp.ac.in",
];

function parseEnvEmailList() {
  const raw = process.env.TEST_LEAD_EMAILS || process.env.TEST_LEAD_EMAIL || "";
  if (!raw.trim()) return null;
  const list = raw
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : null;
}

function getTestEmails() {
  return parseEnvEmailList() || [...DEFAULT_TEST_EMAILS];
}

function getTestEmail(index = 0) {
  const list = getTestEmails();
  return list[Math.abs(index) % list.length];
}

function pickTestEmailForStamp(stamp, salt = "") {
  const list = getTestEmails();
  const key = String(stamp) + String(salt);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return list[hash % list.length];
}

function parseEmailArg(argv = process.argv) {
  const flag = argv.find((a) => a.startsWith("--email="));
  if (flag) return flag.split("=")[1]?.trim().toLowerCase();
  const idx = argv.indexOf("--email");
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1].trim().toLowerCase();
  return null;
}

function resolveTestEmailsFromArgs(argv = process.argv) {
  if (argv.includes("--all")) return getTestEmails();
  const one = parseEmailArg(argv);
  if (one) return [one];
  return [getTestEmail(0)];
}

module.exports = {
  DEFAULT_TEST_EMAILS,
  getTestEmails,
  getTestEmail,
  pickTestEmailForStamp,
  parseEmailArg,
  resolveTestEmailsFromArgs,
};
