const Property = require("../models/propertyModel");
const Client = require("../models/Client");
const {
  scorePropertyForClient,
  matchPropertiesForClient,
} = require("../services/propertyMatchingService");

function toLegacyScore(score0to100) {
  return Math.round(Number(score0to100 || 0)) / 100;
}

function mapPropertyRecommendation(match, property) {
  return {
    propertyId: match.propertyId,
    score: toLegacyScore(match.score),
    propertyDetails: {
      name: property?.name,
      owner: property?.owner,
      city: property?.city,
      roadName: property?.roadName,
      contact: property?.contact,
      address: property?.address,
      area: property?.area,
      shopNo: property?.shopNo,
      exactArea: property?.exactArea,
    },
  };
}

function mapClientRecommendation(match, client) {
  return {
    clientId: match.clientId,
    score: toLegacyScore(match.score),
    clientDetails: {
      name: client?.name,
      email: client?.email,
      phone: client?.phone,
      contactDetails: client?.contactDetails,
      city: client?.city,
      preferredArea: client?.preferredArea,
      otherPreferredAreas: client?.otherPreferredAreas,
      minArea: client?.minimumArea,
      maxArea: client?.maximumArea,
      requirement: client?.requirement,
      specificRequirements: client?.specificRequirements,
      scoringDetails: match.explanation,
    },
  };
}

async function recommendProperties(req, res) {
  try {
    const { clientId } = req.params;
    const result = await matchPropertiesForClient(clientId, {
      limit: 30,
      minScore: 0,
    });

    if (result.error === "client_not_found") {
      return res.status(404).json({ message: "No data found for the specified client." });
    }

    const propertyIds = result.matches.map((m) => m.propertyId);
    const properties = await Property.find({ _id: { $in: propertyIds } }).lean();
    const propertyById = Object.fromEntries(properties.map((p) => [p._id.toString(), p]));

    const recommendations = result.matches.map((match) =>
      mapPropertyRecommendation(match, propertyById[match.propertyId])
    );

    return res.json({ recommendations });
  } catch (err) {
    console.error("Error in recommendation:", err);
    return res.status(500).json({ message: "Error generating recommendations." });
  }
}

async function recommendClient(req, res) {
  try {
    const { propertyId } = req.params;
    const property = await Property.findById(propertyId).lean();
    if (!property) {
      return res.status(404).json({ message: "No suitable clients found for the specified property." });
    }

    const ruleConfigService = require("../services/ruleConfigService");
    const weights = await ruleConfigService.getMatchingWeights();
    const { normalizeText } = require("../config/matchingRules");

    const query = { isVisibility: true };
    if (property.city && normalizeText(property.city) !== "not specified") {
      query.city = new RegExp(
        `^${normalizeText(property.city).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i"
      );
    }

    const clients = await Client.find(query)
      .select(
        "name email contactDetails city preferredArea otherPreferredAreas minimumArea requirement specificRequirements kindOfBusiness expectedRent linkedProperties"
      )
      .limit(300)
      .lean();

    const scored = clients
      .map((client) => {
        const match = scorePropertyForClient(client, property, weights);
        return {
          clientId: client._id.toString(),
          score: match.score,
          explanation: match.explanation,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);

    if (!scored.length) {
      return res.status(404).json({ message: "No suitable clients found for the specified property." });
    }

    const clientIds = scored.map((s) => s.clientId);
    const clientRows = await Client.find({ _id: { $in: clientIds } }).lean();
    const clientById = Object.fromEntries(clientRows.map((c) => [c._id.toString(), c]));

    const recommendations = scored.map((match) =>
      mapClientRecommendation(match, clientById[match.clientId])
    );

    return res.json({ recommendations });
  } catch (err) {
    console.error("Error in recommendClient:", err);
    return res.status(500).json({ message: "Error generating client recommendations." });
  }
}

module.exports = { recommendProperties, recommendClient };
