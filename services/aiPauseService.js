const JourneyProcess = require("../models/JourneyProcess");

async function isAiPaused(correlationId) {
  if (!correlationId) return false;
  const process = await JourneyProcess.findOne({ correlationId }).select("status").lean();
  return process?.status === "PAUSED";
}

async function pauseAi(correlationId, reason = "waiting_human") {
  if (!correlationId) return;
  await JourneyProcess.findOneAndUpdate(
    { correlationId },
    {
      status: "PAUSED",
      pausedReason: reason,
      "context.lastSuccessfulStep": "ai_paused",
    }
  );
}

async function resumeAi(correlationId) {
  if (!correlationId) return;
  await JourneyProcess.findOneAndUpdate(
    { correlationId },
    {
      status: "ACTIVE",
      pausedReason: null,
    }
  );
}

module.exports = {
  isAiPaused,
  pauseAi,
  resumeAi,
};
