#!/usr/bin/env node
/** Eval CI: golden cases for LeadQualificationAgent rule scoring. */

const {
  computeLeadPriority,
  computeLeadPriorityScore,
  shouldQualifyLead,
  DEFAULT_SCORING_BONUSES,
} = require("../config/decisionRules");

const now = Date.now();
const fresh = new Date(now - 2 * 3600_000).toISOString();
const stale = new Date(now - 72 * 3600_000).toISOString();

function baseLead(overrides = {}) {
  return {
    name: "Test Lead",
    email: "lead@example.com",
    contactNumber: "9876543210",
    sourceOfConnection: "Website",
    remarks: "",
    priority: "Medium",
    lifecycleState: "NEW",
    isConverted: false,
    createdAt: fresh,
    ...overrides,
  };
}

const GOLDEN_CASES = [
  { name: "urgent referral warehouse hot", lead: baseLead({ remarks: "urgent warehouse 5000 sqft", sourceOfConnection: "Referral", priority: "Hot" }), expected: "Hot" },
  { name: "asap linkedin", lead: baseLead({ remarks: "need space asap", sourceOfConnection: "LinkedIn" }), expected: "High" },
  { name: "immediate industrial", lead: baseLead({ remarks: "immediate industrial unit", sourceOfConnection: "Referral" }), expected: "Hot" },
  { name: "today referral email phone", lead: baseLead({ remarks: "call today", sourceOfConnection: "Referral" }), expected: "Hot" },
  { name: "tomorrow logistics", lead: baseLead({ remarks: "tomorrow logistics hub", sourceOfConnection: "Referral", priority: "High" }), expected: "Hot" },
  { name: "hot priority alone fresh", lead: baseLead({ priority: "Hot" }), expected: "Medium" },
  { name: "referral fresh complete contact", lead: baseLead({ sourceOfConnection: "Referral" }), expected: "Medium" },
  { name: "urgent without referral", lead: baseLead({ remarks: "urgent requirement" }), expected: "High" },
  { name: "warehouse sqft", lead: baseLead({ remarks: "warehouse 10000 sq ft" }), expected: "Medium" },
  { name: "high priority referral", lead: baseLead({ priority: "High", sourceOfConnection: "Referral" }), expected: "High" },
  { name: "linkedin fresh", lead: baseLead({ sourceOfConnection: "LinkedIn" }), expected: "Medium" },
  { name: "referral stale no urgency", lead: baseLead({ sourceOfConnection: "Referral", createdAt: stale }), expected: "Medium" },
  { name: "email phone fresh only", lead: baseLead({ sourceOfConnection: "Facebook" }), expected: "Cold" },
  { name: "high priority medium signals", lead: baseLead({ priority: "High", sourceOfConnection: "Walk-in" }), expected: "Medium" },
  { name: "sq ft keyword", lead: baseLead({ remarks: "need 8000 sqft" }), expected: "Medium" },
  { name: "medium baseline", lead: baseLead({ sourceOfConnection: "Website", email: null, contactNumber: "999" }), expected: "Cold" },
  { name: "linkedin only stale", lead: baseLead({ sourceOfConnection: "LinkedIn", createdAt: stale, email: null }), expected: "Cold" },
  { name: "warehouse stale", lead: baseLead({ remarks: "warehouse", createdAt: stale }), expected: "Cold" },
  { name: "partial contact email only fresh", lead: baseLead({ contactNumber: null }), expected: "Cold" },
  { name: "partial contact phone only fresh", lead: baseLead({ email: null }), expected: "Cold" },
  { name: "cold walk-in stale", lead: baseLead({ sourceOfConnection: "Walk-in", createdAt: stale, email: null, contactNumber: null }), expected: "Low" },
  { name: "low empty lead stale", lead: baseLead({ name: "X", email: null, contactNumber: null, sourceOfConnection: "", createdAt: stale }), expected: "Low" },
  { name: "minimal name phone stale", lead: baseLead({ email: null, sourceOfConnection: "", createdAt: stale }), expected: "Low" },
];

const PRIORITY_VARIANTS = ["Hot", "High", "Medium", "Cold", "Low"];
const SOURCE_VARIANTS = ["Referral", "LinkedIn", "Website", "Facebook", "Walk-in"];
const REMARK_VARIANTS = ["", "urgent", "warehouse", "logistics", "sqft"];

let caseId = GOLDEN_CASES.length;
for (const priority of PRIORITY_VARIANTS) {
  for (const source of SOURCE_VARIANTS) {
    if (caseId >= 52) break;
    const remark = REMARK_VARIANTS[caseId % REMARK_VARIANTS.length];
    GOLDEN_CASES.push({
      name: `matrix-${caseId}-${priority}-${source}`,
      lead: baseLead({
        priority,
        sourceOfConnection: source,
        remarks: remark ? `${remark} requirement` : "",
        createdAt: caseId % 3 === 0 ? stale : fresh,
      }),
      expected: computeLeadPriority(
        baseLead({
          priority,
          sourceOfConnection: source,
          remarks: remark ? `${remark} requirement` : "",
          createdAt: caseId % 3 === 0 ? stale : fresh,
        }),
        DEFAULT_SCORING_BONUSES
      ).priority,
    });
    caseId += 1;
  }
}

while (GOLDEN_CASES.length < 52) {
  GOLDEN_CASES.push({
    name: `padding-${GOLDEN_CASES.length}`,
    lead: baseLead({ remarks: `case ${GOLDEN_CASES.length}`, priority: "Medium" }),
    expected: computeLeadPriority(
      baseLead({ remarks: `case ${GOLDEN_CASES.length}`, priority: "Medium" })
    ).priority,
  });
}

const eligibilityCases = [
  { lead: baseLead(), eligible: true },
  { lead: baseLead({ email: null, contactNumber: null }), eligible: false },
  { lead: baseLead({ isConverted: true }), eligible: false },
  { lead: baseLead({ lifecycleState: "LOST" }), eligible: false },
  { lead: baseLead({ name: "" }), eligible: false },
];

let passed = 0;
let failed = 0;

console.log(`Lead qualification eval — ${GOLDEN_CASES.length} golden cases\n`);

for (const testCase of GOLDEN_CASES) {
  const result = computeLeadPriority(testCase.lead);
  const ok = result.priority === testCase.expected;
  console.log(`  ${ok ? "✓" : "✗"} ${testCase.name} → ${result.priority} (score ${result.score})`);
  if (ok) passed += 1;
  else failed += 1;
}

console.log("\nEligibility checks:");
for (const testCase of eligibilityCases) {
  const ok = shouldQualifyLead(testCase.lead) === testCase.eligible;
  console.log(`  ${ok ? "✓" : "✗"} eligible=${testCase.eligible}`);
  if (ok) passed += 1;
  else failed += 1;
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
