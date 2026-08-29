/**
 * Legacy export — rule-based matching (no TensorFlow).
 * API routes use propertyMatchingService directly; this wrapper keeps old scripts working.
 */
const { matchPropertiesForClient } = require("../services/propertyMatchingService");

async function preprocessData(clientId) {
  try {
    const result = await matchPropertiesForClient(clientId, { limit: 30, minScore: 0 });
    if (result.error) return [];

    return result.matches.map((match) => ({
      propertyId: match.propertyId,
      score: Number(match.score || 0) / 100,
      propertyDetails: {
        ...match.propertySummary,
        scoringDetails: { explanation: match.explanation },
      },
    }));
  } catch (error) {
    console.error("Error during data preprocessing:", error.message);
    return [];
  }
}

module.exports = { preprocessData };
