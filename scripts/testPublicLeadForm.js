/**
 * Public lead form validation smoke test.
 * Run: node scripts/testPublicLeadForm.js
 */
require("dotenv").config();

const {
  validatePublicLeadBody,
} = require("../controllers/publicLeadController");

function assert(label, condition) {
  const ok = Boolean(condition);
  console.log(ok ? "PASS" : "FAIL", label);
  if (!ok) process.exitCode = 1;
}

console.log("\n=== Public lead form validation ===\n");

const valid = validatePublicLeadBody({
  name: "Test Co",
  email: "test@example.com",
  contactNumber: "9876543210",
  state: "Mumbai",
  remarks: "Need 1000 sqft retail in Andheri",
});
assert("valid submission", valid.ok && valid.data.sourceOfConnection === "public_form");

const honeypot = validatePublicLeadBody({ name: "Bot", _hp: "spam" });
assert("honeypot rejected", !honeypot.ok);

const badEmail = validatePublicLeadBody({
  name: "Test",
  email: "not-an-email",
  contactNumber: "9876543210",
});
assert("bad email rejected", !badEmail.ok);

console.log("\nDone.\n");
