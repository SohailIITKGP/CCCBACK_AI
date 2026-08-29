/**
 * Unit test for client property share email formatting.
 * Run: node scripts/testClientPropertyShareEmail.js
 */
const {
  buildPropertyList,
  buildTemplateVariables,
  TEMPLATE_ID,
} = require("../services/clientPropertyShareEmailService");
const { renderTemplate } = require("../services/templateService");

function assert(label, condition) {
  const ok = Boolean(condition);
  console.log(ok ? "PASS" : "FAIL", label);
  if (!ok) process.exitCode = 1;
}

const matches = [
  {
    propertyId: "p1",
    score: 88,
    explanation: "City match (Mumbai); Area within requirement",
    propertySummary: {
      name: "Andheri Retail Space",
      city: "Mumbai",
      roadName: "Andheri East",
      exactArea: 1200,
      expectedRent: 85000,
    },
  },
  {
    propertyId: "p2",
    score: 76,
    explanation: "Rent near budget",
    propertySummary: {
      name: "Bandra Office",
      city: "Mumbai",
      roadName: "Bandra West",
      area: 950,
      expectedRent: 72000,
    },
  },
];

const client = {
  name: "Test Client",
  contactPerson: "Raj",
  city: "Mumbai",
  preferredArea: "Andheri",
  email: "client@example.com",
};

console.log("\n=== Client property share email test ===\n");

assert("template id set", TEMPLATE_ID === "client_properties_share_v1");

const list = buildPropertyList(matches);
assert("property list includes first property", list.includes("Andheri Retail Space"));
assert("property list includes score", list.includes("88/100"));
assert("property list includes rent", list.includes("85,000"));

const proposalInfo = {
  propertyName: "Andheri Retail Space",
  proposalLink: "https://aicrm.webwonders.co.in/proposal/public/test-opp-id",
};
const variables = buildTemplateVariables(client, matches, proposalInfo);
assert("match count is 2", variables.matchCount === "2");
assert("propertyList populated", variables.propertyList.length > 50);
assert("proposal block includes link", variables.proposalBlock.includes("proposal/public"));

const rendered = renderTemplate(
  {
    templateId: TEMPLATE_ID,
    subject: "{{matchCount}} property options for you — {{city}}",
    body: `Hi {{clientName}},\n\n{{propertyList}}\n\n{{proposalBlock}}\nReply with your choice.`,
    allowedVariables: [
      "clientName",
      "personalizedLine",
      "city",
      "matchCount",
      "propertyList",
      "proposalLink",
      "proposalPropertyName",
      "proposalBlock",
    ],
  },
  variables
);

assert("subject rendered", rendered.subject === "2 property options for you — Mumbai");
assert("body includes property name", rendered.body.includes("Andheri Retail Space"));
assert("body includes proposal link", rendered.body.includes("proposal/public"));

console.log("\nSample subject:", rendered.subject);
console.log("\nDone.\n");
