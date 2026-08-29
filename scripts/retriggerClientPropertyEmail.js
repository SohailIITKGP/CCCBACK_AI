#!/usr/bin/env node
/**
 * Re-run property matching + property/proposal email for an existing client.
 *
 *   node scripts/retriggerClientPropertyEmail.js --email=client@example.com
 *   node scripts/retriggerClientPropertyEmail.js --email=client@example.com --force
 *   node scripts/retriggerClientPropertyEmail.js --id=<clientId> --set-city=Noida --set-area="Sector 62" --set-size=2000 --set-budget=650000 --set-business=office
 */
require("dotenv").config();

const connectDB = require("../config/db");
const {
  parseRequirementsFromEmail,
  extractLatestReplyBlock,
  repairRequirementsFromRemarks,
  isMalformedRequirements,
} = require("../services/emailRequirementParserService");
const { emitRequirementsUpdated } = require("../facades/clientFacade");
const { runInlineOrchestration, drainOutbox } = require("../services/orchestrationTestHarness");
const { getAutomationSettings } = require("../services/agentAutomationService");
const propertyMatchingService = require("../services/propertyMatchingService");
const { resumeAi } = require("../services/aiPauseService");
const Client = require("../models/Client");
const AgentAction = require("../models/AgentAction");
const AgentLog = require("../models/AgentLog");
const DomainEvent = require("../models/DomainEvent");

function parseArg(prefix) {
  return process.argv.find((a) => a.startsWith(`${prefix}=`))?.slice(prefix.length + 1);
}

async function main() {
  const emailArg = parseArg("--email");
  const idArg = parseArg("--id");
  const force = process.argv.includes("--force");

  if (!emailArg && !idArg) {
    console.error("Usage: --email=user@example.com OR --id=<clientId> [--force] [--set-city=...]");
    process.exit(1);
  }

  await connectDB();

  let client = emailArg
    ? await Client.findOne({ email: emailArg })
    : await Client.findById(idArg);

  if (!client) {
    console.error("Client not found");
    process.exit(1);
  }

  console.log("Client:", client.name, client.email);
  console.log("Requirements before:", {
    city: client.city,
    preferredArea: client.preferredArea,
    minimumArea: client.minimumArea,
    expectedRent: client.expectedRent,
    kindOfBusiness: client.kindOfBusiness,
  });

  if (isMalformedRequirements(client)) {
    console.log("\n⚠ Requirements look corrupted — will repair from latest email reply.");
  }

  const manual = {
    city: parseArg("--set-city"),
    preferredArea: parseArg("--set-area"),
    minimumArea: parseArg("--set-size"),
    expectedRent: parseArg("--set-budget"),
    kindOfBusiness: parseArg("--set-business"),
  };

  const repaired = repairRequirementsFromRemarks(client.remarks, client);
  const updates = {};

  for (const key of [
    "city",
    "preferredArea",
    "minimumArea",
    "expectedRent",
    "kindOfBusiness",
    "requirement",
  ]) {
    const manualVal = manual[key === "minimumArea" ? "minimumArea" : key];
    const fromManual =
      key === "city"
        ? manual.city
        : key === "preferredArea"
          ? manual.preferredArea
          : key === "minimumArea"
            ? manual.minimumArea
            : key === "expectedRent"
              ? manual.expectedRent
              : key === "kindOfBusiness"
                ? manual.kindOfBusiness
                : null;

    const value = fromManual || repaired[key];
    if (!value) continue;

    if (force || isMalformedRequirements(client) || !client[key] || fromManual) {
      if (client[key] !== value) updates[key] = value;
    }
  }

  if (updates.requirement || updates.kindOfBusiness) {
    updates.requirement = updates.kindOfBusiness || updates.requirement || repaired.requirement;
  }

  if (Object.keys(updates).length) {
    await Client.findByIdAndUpdate(client._id, updates);
    client = await Client.findById(client._id);
    console.log("\nUpdated client requirements:", updates);
  } else {
    console.log("\nNo requirement updates applied (use --force or --set-city=... to override).");
  }

  console.log("Requirements after repair:", {
    city: client.city,
    preferredArea: client.preferredArea,
    minimumArea: client.minimumArea,
    expectedRent: client.expectedRent,
    kindOfBusiness: client.kindOfBusiness,
  });

  const preview = await propertyMatchingService.matchPropertiesForClient(client._id);
  console.log("\nMatch preview:", preview.candidateCount, "candidates,", preview.matches?.length || 0, "matches");
  preview.matches?.slice(0, 3).forEach((m) => {
    console.log(`  - ${m.propertySummary?.name} (${m.score}/100)`);
  });

  if (!preview.matches?.length) {
    console.error("\nStill no matches — check city/seed properties: npm run seed:properties");
    process.exit(1);
  }

  await resumeAi(client.correlationId);

  const settings = await getAutomationSettings(true);
  console.log("\nAutomation:", {
    autoSharePropertiesEmail: settings.autoSharePropertiesEmail,
    autoSendProposalEmail: settings.autoSendProposalEmail,
    autoLinkHighScore: settings.autoLinkHighScore,
  });

  // Allow re-run matching after requirements fix
  await DomainEvent.deleteMany({
    correlationId: client.correlationId,
    eventType: "property.matched",
    "payload.clientId": client._id.toString(),
  });

  await emitRequirementsUpdated(client, { type: "user", userId: client.whoConverted });
  await drainOutbox();
  await runInlineOrchestration(client.correlationId, 12);

  const shareAction = await AgentAction.findOne({
    correlationId: client.correlationId,
    intent: "send_email",
    "payload.templateId": "client_properties_share_v1",
  })
    .sort({ createdAt: -1 })
    .lean();

  const logs = await AgentLog.find({ correlationId: client.correlationId })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  console.log("\nLatest agent logs:");
  logs.forEach((l) => console.log(` - [${l.result}] ${l.agentName || "system"}: ${l.message}`));

  if (shareAction) {
    console.log("\nProperty share action:", shareAction.status, shareAction._id.toString());
    if (shareAction.payload?.proposalLink) {
      console.log("Proposal link:", shareAction.payload.proposalLink);
    }
  } else {
    console.log("\nNo property share email action yet — check AI Hub for pending approvals.");
  }

  await require("mongoose").disconnect();
  await require("../queues/connection").closeRedisConnection().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await require("../queues/connection").closeRedisConnection();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
