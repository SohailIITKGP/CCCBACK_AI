/** Rule-based property matching weights (0–100 total). No LLM required. */
const WEIGHTS = {
  city: 25,
  area: 25,
  rent: 20,
  location: 20,
  category: 10,
};

const MIN_SUGGESTION_SCORE = 20;
const TOP_SUGGESTION_COUNT = 3;
const CANDIDATE_POOL_LIMIT = 200;

function parseNumeric(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[,₹]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function parseAreaRange(client) {
  let min = parseNumeric(client.minimumArea) ?? 0;
  let max = Infinity;

  const req = String(client.requirement || "");
  const rangeMatch = req.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (rangeMatch) {
    min = parseInt(rangeMatch[1], 10) || min;
    max = parseInt(rangeMatch[2], 10) || max;
  }

  return { min, max };
}

function parseRentRange(expectedRent) {
  const raw = String(expectedRent || "").trim();
  if (!raw) return { min: null, max: null };
  const rangeMatch = raw.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (rangeMatch) {
    return {
      min: parseInt(rangeMatch[1], 10),
      max: parseInt(rangeMatch[2], 10),
    };
  }
  const single = parseNumeric(raw);
  if (single != null) {
    return { min: single * 0.85, max: single * 1.15 };
  }
  return { min: null, max: null };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function collectPreferredRoads(client) {
  const roads = [];
  if (client.preferredArea) roads.push(normalizeText(client.preferredArea));
  if (client.otherPreferredAreas) {
    client.otherPreferredAreas
      .split(",")
      .map((s) => normalizeText(s))
      .filter(Boolean)
      .forEach((r) => roads.push(r));
  }
  return [...new Set(roads.filter((r) => r && r !== "not specified"))];
}

module.exports = {
  WEIGHTS,
  MIN_SUGGESTION_SCORE,
  TOP_SUGGESTION_COUNT,
  CANDIDATE_POOL_LIMIT,
  parseNumeric,
  parseAreaRange,
  parseRentRange,
  normalizeText,
  collectPreferredRoads,
};
