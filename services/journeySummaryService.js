const DomainEvent = require("../models/DomainEvent");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getGeminiModelName } = require("../config/gemini");

async function summarizeJourney(correlationId) {
  const events = await DomainEvent.find({ correlationId })
    .sort({ "metadata.timestamp": 1 })
    .lean();

  if (!events.length) {
    return { summary: "No journey events found for this correlation ID." };
  }

  const timeline = events.map((e) => ({
    type: e.eventType,
    at: e.metadata?.timestamp,
    payload: e.payload,
  }));

  if (!process.env.GEMINI_API_KEY) {
    const lines = timeline.map((t) => `- ${t.type} (${t.at})`);
    return {
      summary: `Journey timeline (${events.length} events):\n${lines.join("\n")}`,
      source: "rules",
    };
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: getGeminiModelName() });
    const result = await model.generateContent(
      `Summarize this real estate CRM lead journey in 5-8 bullet points for a manager. Be factual, no invented details.\n\n${JSON.stringify(timeline)}`
    );
    return {
      summary: result.response.text().trim(),
      source: "gemini",
      eventCount: events.length,
    };
  } catch (err) {
    return {
      summary: `Could not generate AI summary: ${err.message}`,
      source: "error",
      eventCount: events.length,
    };
  }
}

module.exports = {
  summarizeJourney,
};
