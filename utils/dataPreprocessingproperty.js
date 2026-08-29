/**
 * Legacy export — rule-based matching (no TensorFlow).
 */
const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const { scorePropertyForClient } = require("../services/propertyMatchingService");
const ruleConfigService = require("../services/ruleConfigService");
const { normalizeText } = require("../config/matchingRules");

async function preprocessData(propertyId) {
  try {
    const property = await Property.findById(propertyId).lean();
    if (!property) return [];

    const weights = await ruleConfigService.getMatchingWeights();
    const query = { isVisibility: true };
    if (property.city && normalizeText(property.city) !== "not specified") {
      query.city = new RegExp(
        `^${normalizeText(property.city).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i"
      );
    }

    const clients = await Client.find(query).limit(300).lean();
    return clients
      .map((client) => {
        const match = scorePropertyForClient(client, property, weights);
        return {
          clientId: client._id,
          score: Number(match.score || 0) / 100,
          clientDetails: {
            name: client.name,
            email: client.email,
            contactDetails: client.contactDetails,
            city: client.city,
            preferredArea: client.preferredArea,
            requirement: client.requirement,
            scoringDetails: { explanation: match.explanation },
          },
        };
      })
      .sort((a, b) => b.score - a.score);
  } catch (error) {
    console.error("Error during data preprocessing:", error.message);
    return [];
  }
}

module.exports = { preprocessData };
