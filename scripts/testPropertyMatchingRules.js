/**
 * Unit tests for rule-based property matching (no DB, no LLM).
 * Run: node scripts/testPropertyMatchingRules.js
 */
const assert = require("assert");
const { scorePropertyForClient } = require("../services/propertyMatchingService");

const sampleClient = {
  _id: "client1",
  city: "Mumbai",
  preferredArea: "Andheri",
  expectedRent: "500000",
  minimumArea: "4000",
  requirement: "warehouse 4000-6000",
  kindOfBusiness: "warehouse",
};

const goodProperty = {
  _id: "prop1",
  name: "Andheri Warehouse",
  city: "Mumbai",
  roadName: "Andheri",
  exactArea: "5000",
  expectedRent: "520000",
  category: "warehouse",
  clusters: ["Andheri East"],
};

const badCityProperty = {
  ...goodProperty,
  _id: "prop2",
  city: "Pune",
};

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

test("strong match scores >= 70", () => {
  const { score } = scorePropertyForClient(sampleClient, goodProperty);
  assert.ok(score >= 70, `expected >=70 got ${score}`);
});

test("wrong city scores lower than strong match", () => {
  const good = scorePropertyForClient(sampleClient, goodProperty).score;
  const bad = scorePropertyForClient(sampleClient, badCityProperty).score;
  assert.ok(bad < good, `bad ${bad} should be < good ${good}`);
});

test("explanation includes city match text", () => {
  const { explanation } = scorePropertyForClient(sampleClient, goodProperty);
  assert.ok(explanation.toLowerCase().includes("city"), explanation);
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
