/**
 * Unit tests for inbound email requirement parsing (no DB).
 * Run: node scripts/testEmailRequirementParser.js
 */
const assert = require("assert");
const {
  parseRequirementsFromEmail,
  isCompleteForConversion,
} = require("../services/emailRequirementParserService");

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
  }
}

test("parses warehouse reply with city, area, size, rent", () => {
  const body = `
    Hi team,
    City: Mumbai
    Area: Andheri East
    Size: 5000 sqft
    Rent: Rs 5,00,000
    We need warehouse space for logistics.
  `;
  const parsed = parseRequirementsFromEmail(body);
  assert.strictEqual(parsed.city?.toLowerCase(), "mumbai");
  assert.ok(parsed.preferredArea?.toLowerCase().includes("andheri"));
  assert.strictEqual(parsed.minimumArea, "5000");
  assert.ok(parsed.expectedRent);
  assert.ok(isCompleteForConversion(parsed));
});

test("incomplete when only city mentioned", () => {
  const parsed = parseRequirementsFromEmail("We are looking in Pune for something soon.");
  assert.ok(parsed.city);
  assert.strictEqual(isCompleteForConversion(parsed), false);
});

test("complete with city, locality keyword, and business type", () => {
  const body = "Need office in Bangalore near Whitefield, budget Rs 200000";
  const parsed = parseRequirementsFromEmail(body);
  assert.ok(parsed.city);
  assert.ok(parsed.preferredArea || parsed.kindOfBusiness);
  assert.ok(isCompleteForConversion(parsed));
});

test("parses structured Noida reply", () => {
  const body = `City: Noida
Preferred area: Sector 62
Required size: 2000 sqft
Budget: 650000
Type of business: office`;
  const parsed = parseRequirementsFromEmail(body);
  assert.strictEqual(parsed.city, "Noida");
  assert.ok(parsed.preferredArea?.includes("Sector 62"));
  assert.strictEqual(parsed.minimumArea, "2000");
  assert.strictEqual(parsed.expectedRent, "650000");
  assert.strictEqual(parsed.kindOfBusiness, "office");
  assert.ok(isCompleteForConversion(parsed));
});

test("ignores quoted previous reply in thread", () => {
  const body = `City: Noida
Preferred area: Sector 62
Required size: 2000 sqft
Budget: 650000
Type of business: office

On Thu, 18 Jun 2026 at 08:33, Rewa Realtors CRM wrote:
City: Surat
Preferred area: Varachha
Required size: 1200 sqft
Budget: 450000
Type of business: warehouse`;
  const parsed = parseRequirementsFromEmail(body);
  assert.strictEqual(parsed.city, "Noida");
  assert.strictEqual(parsed.kindOfBusiness, "office");
  assert.notStrictEqual(parsed.city, "Surat");
});

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);

console.log(`\nEmail requirement parser: ${passed}/${results.length} passed`);
for (const r of results) {
  console.log(r.ok ? "  ✓" : "  ✗", r.name, r.ok ? "" : `— ${r.err}`);
}

if (failed.length) process.exit(1);
