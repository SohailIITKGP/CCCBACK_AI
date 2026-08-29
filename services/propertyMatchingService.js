const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const {
  WEIGHTS,
  MIN_SUGGESTION_SCORE,
  TOP_SUGGESTION_COUNT,
  CANDIDATE_POOL_LIMIT,
  parseNumeric,
  parseAreaRange,
  parseRentRange,
  normalizeText,
  collectPreferredRoads,
} = require("../config/matchingRules");
const { getEffectiveRequirements, extractCityToken } = require("./emailRequirementParserService");

function getPropertyArea(property) {
  return parseNumeric(property.exactArea) ?? parseNumeric(property.area);
}

function scoreCity(client, property, weights = WEIGHTS) {
  const clientCity = normalizeText(client.city);
  const propCity = normalizeText(property.city);
  if (!clientCity || clientCity === "not specified") {
    return { points: weights.city * 0.5, note: "Client city not specified (partial credit)" };
  }
  if (!propCity) return { points: 0, note: "Property city missing" };
  if (clientCity === propCity) return { points: weights.city, note: `City match (${property.city})` };
  if (propCity.includes(clientCity) || clientCity.includes(propCity)) {
    return { points: weights.city * 0.6, note: `Partial city match (${property.city})` };
  }
  return { points: 0, note: `City mismatch (${property.city} vs ${client.city})` };
}

function scoreArea(client, property, weights = WEIGHTS) {
  const propArea = getPropertyArea(property);
  if (propArea == null) return { points: 0, note: "Property area unknown" };

  const { min, max } = parseAreaRange(client);
  if (propArea >= min && propArea <= max) {
    return { points: weights.area, note: `Area ${propArea} sqft within requirement` };
  }
  if (propArea >= min * 0.9 && propArea <= max * 1.1) {
    return { points: weights.area * 0.7, note: `Area ${propArea} sqft close to requirement` };
  }
  if (min > 0 && propArea >= min * 0.75) {
    return { points: weights.area * 0.4, note: `Area ${propArea} sqft below ideal range` };
  }
  return { points: 0, note: `Area ${propArea} sqft outside range` };
}

function scoreRent(client, property, weights = WEIGHTS) {
  const rent = parseNumeric(property.expectedRent) ?? parseNumeric(property.lumsumRent);
  const range = parseRentRange(client.expectedRent);
  if (rent == null || range.min == null) {
    return { points: weights.rent * 0.3, note: "Rent comparison skipped (missing data)" };
  }
  if (rent >= range.min && rent <= range.max) {
    return { points: weights.rent, note: `Rent ₹${rent} within budget` };
  }
  const mid = (range.min + range.max) / 2;
  const diffPct = Math.abs(rent - mid) / Math.max(mid, 1);
  if (diffPct <= 0.25) {
    return { points: weights.rent * 0.6, note: `Rent ₹${rent} near budget` };
  }
  return { points: 0, note: `Rent ₹${rent} outside budget` };
}

function scoreLocation(client, property, weights = WEIGHTS) {
  const roads = collectPreferredRoads(client);
  const propRoad = normalizeText(property.roadName);
  if (!roads.length) {
    return { points: weights.location * 0.4, note: "Preferred area not specified" };
  }
  if (!propRoad) return { points: 0, note: "Property road/area missing" };

  for (const road of roads) {
    if (propRoad === road || propRoad.includes(road) || road.includes(propRoad)) {
      return { points: weights.location, note: `Location match (${property.roadName})` };
    }
  }
  const clusters = (property.clusters || []).map(normalizeText);
  if (clusters.some((c) => roads.some((r) => c.includes(r) || r.includes(c)))) {
    return { points: weights.location * 0.7, note: `Cluster near preferred area` };
  }
  return { points: 0, note: `Location ${property.roadName || "—"} not in preferred list` };
}

function scoreCategory(client, property, weights = WEIGHTS) {
  const req = normalizeText(client.requirement || client.kindOfBusiness);
  const cat = normalizeText(property.category);
  if (!req || req === "not specified") {
    return { points: weights.category * 0.5, note: "Category not specified on client" };
  }
  if (!cat) return { points: 0, note: "Property category missing" };
  if (req.includes(cat) || cat.includes(req)) {
    return { points: weights.category, note: `Category fit (${property.category})` };
  }
  return { points: weights.category * 0.3, note: "Weak category alignment" };
}

function scorePropertyForClient(client, property, weights = WEIGHTS) {
  const parts = [
    scoreCity(client, property, weights),
    scoreArea(client, property, weights),
    scoreRent(client, property, weights),
    scoreLocation(client, property, weights),
    scoreCategory(client, property, weights),
  ];

  const score = Math.round(parts.reduce((sum, p) => sum + p.points, 0));
  const explanation = parts
    .filter((p) => p.points > 0)
    .map((p) => p.note)
    .join("; ");

  return {
    propertyId: property._id.toString(),
    score,
    explanation: explanation || "Low rule-based match score",
    filtersApplied: {
      city: client.city,
      preferredArea: client.preferredArea,
      expectedRent: client.expectedRent,
      minimumArea: client.minimumArea,
    },
    propertySummary: {
      name: property.name,
      city: property.city,
      roadName: property.roadName,
      area: property.area,
      exactArea: property.exactArea,
      expectedRent: property.expectedRent,
      address: property.address,
    },
  };
}

async function loadClient(clientId) {
  const row = await Client.findById(clientId).lean();
  if (!row) return null;
  return getEffectiveRequirements(row);
}

async function loadCandidateProperties(client) {
  const linkedIds = (client.linkedProperties || []).map(String);
  const query = {
    isVisibility: true,
    isArchive: false,
    propertyStatus: "approved",
    _id: { $nin: client.linkedProperties || [] },
  };

  const cityForQuery =
    extractCityToken(client.city) ||
    (client.city && normalizeText(client.city).length <= 25 ? normalizeText(client.city) : null);

  if (cityForQuery && cityForQuery !== "not specified") {
    query.city = new RegExp(`^${cityForQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  }

  return Property.find(query)
    .select("name city roadName area exactArea expectedRent lumsumRent category clusters address")
    .limit(CANDIDATE_POOL_LIMIT)
    .lean()
    .then((rows) => rows.filter((p) => !linkedIds.includes(p._id.toString())));
}

async function matchPropertiesForClient(clientId, { limit = TOP_SUGGESTION_COUNT, minScore = MIN_SUGGESTION_SCORE } = {}) {
  const client = await loadClient(clientId);
  if (!client) return { error: "client_not_found", matches: [] };

  const ruleConfigService = require("./ruleConfigService");
  const weights = await ruleConfigService.getMatchingWeights();

  const { loadMemoryForClient, getRejectedPropertyIds, applyMemoryAdjustments } = require("./clientPreferenceMemoryService");
  const memory = await loadMemoryForClient(clientId);
  const rejectedIds = new Set(getRejectedPropertyIds(memory));

  const candidates = await loadCandidateProperties(client);
  const scored = candidates
    .filter((property) => !rejectedIds.has(property._id.toString()))
    .map((property) => {
      const base = scorePropertyForClient(client, property, weights);
      return applyMemoryAdjustments(base, property, memory);
    })
    .filter((m) => m.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m, index) => ({ ...m, rank: index + 1 }));

  return {
    clientId: client._id.toString(),
    correlationId: client.correlationId,
    matches: scored,
    candidateCount: candidates.length,
    memoryFilteredCount: rejectedIds.size,
  };
}

module.exports = {
  scorePropertyForClient,
  matchPropertiesForClient,
  loadCandidateProperties,
};
