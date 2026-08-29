const { CLIENT_INTENTS, REVIEW_THRESHOLD } = require("../config/clientIntentLibrary");

function cleanReplyText(text = "") {
  return String(text)
    .replace(/^>.*$/gm, "")
    .replace(/On .+ wrote:[\s\S]*/i, "")
    .replace(/\r/g, "")
    .trim();
}

function extractOptionNumber(text, intent) {
  if (!intent.extractOptionNumber) return null;
  for (const pattern of intent.patterns) {
    const match = text.match(pattern);
    if (match?.[1] && /^\d+$/.test(match[1])) {
      return parseInt(match[1], 10);
    }
  }
  const generic = text.match(/\boption\s*#?\s*(\d+)\b/i);
  if (generic?.[1]) return parseInt(generic[1], 10);
  return null;
}

/**
 * Detect client intent from inbound email/text.
 * Returns { intentId, workflow, confidence, optionNumber, matches, needsReview }
 */
function detectClientIntent(rawText = "") {
  const text = cleanReplyText(rawText);
  if (!text || text.length < 2) {
    return {
      intentId: null,
      workflow: null,
      confidence: 0,
      needsReview: true,
      reason: "empty_text",
      text,
    };
  }

  let best = null;

  for (const intent of CLIENT_INTENTS) {
    for (const pattern of intent.patterns) {
      if (pattern.test(text)) {
        const confidence = Math.min(0.95, intent.minConfidence + 0.1);
        if (!best || confidence > best.confidence) {
          best = {
            intentId: intent.id,
            label: intent.label,
            workflow: intent.workflow,
            confidence,
            minConfidence: intent.minConfidence,
            optionNumber: extractOptionNumber(text, intent),
            matchedPattern: pattern.toString(),
          };
        }
        break;
      }
    }
  }

  if (!best) {
    return {
      intentId: null,
      workflow: null,
      confidence: 0,
      needsReview: true,
      reason: "no_intent_match",
      text: text.slice(0, 500),
    };
  }

  const needsReview = best.confidence < REVIEW_THRESHOLD || best.confidence < best.minConfidence;

  return {
    ...best,
    needsReview,
    text: text.slice(0, 500),
  };
}

module.exports = {
  detectClientIntent,
  cleanReplyText,
};
