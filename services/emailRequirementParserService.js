/** Rule-based extraction of property requirements from inbound email text. */

function stripHtml(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r\n/g, "\n");
}

/**
 * Keep only the user's latest reply — drop Gmail/Outlook quoted thread below.
 */
function stripQuotedReplyContent(rawText) {
  let text = stripHtml(rawText);

  const cutPatterns = [
    /\n\s*On .+wrote:\s*\n/i,
    /\n\s*On .+, .+ at .+, .+ wrote:\s*\n/i,
    /\n\s*-----\s*Original Message\s*-----/i,
    /\n\s*From:\s*.+\nSent:\s*.+\nTo:/i,
    /\n\s*>+\s*City:/i,
    /\n\s*Rewa Realtors CRM\s*<[^>]+>\s*wrote:/i,
  ];

  for (const pattern of cutPatterns) {
    const match = text.match(pattern);
    if (match?.index != null && match.index > 0) {
      text = text.slice(0, match.index);
    }
  }

  // Drop lines that are clearly quoted (start with >)
  text = text
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");

  return text.trim();
}

function cleanText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLatestReplyBlock(remarks) {
  const text = String(remarks || "");
  const marker = "[From email reply]";
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return text;
  return text.slice(idx + marker.length).trim();
}

const KNOWN_CITIES = [
  "mumbai",
  "delhi",
  "ncr",
  "gurgaon",
  "noida",
  "pune",
  "bangalore",
  "bengaluru",
  "hyderabad",
  "chennai",
  "ahmedabad",
  "kolkata",
  "jaipur",
  "indore",
  "surat",
];

function extractCityToken(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const city of KNOWN_CITIES) {
    if (lower.includes(city)) {
      return city.charAt(0).toUpperCase() + city.slice(1);
    }
  }
  if (text.length <= 30 && !/preferred|required|size|budget|locality|sqft/i.test(text)) {
    return text.split(/\s+/)[0];
  }
  return null;
}

function isMalformedRequirements(client = {}) {
  const city = String(client.city || "");
  if (city.length > 35) return true;
  if (/preferred area|required size|budget|locality|sqft/i.test(city)) return true;
  if (client.preferredArea && String(client.preferredArea).toLowerCase() === "area") return true;
  return false;
}

/**
 * Build clean requirement fields from latest email reply block + salvage bad DB values.
 */
function repairRequirementsFromRemarks(remarks, existing = {}) {
  const parsed = parseRequirementsFromEmail(extractLatestReplyBlock(remarks || ""));

  const city =
    parsed.city ||
    extractCityToken(existing.city) ||
    (existing.city && !isMalformedRequirements({ city: existing.city }) ? existing.city : null);

  const preferredArea =
    parsed.preferredArea ||
    (existing.preferredArea && String(existing.preferredArea).toLowerCase() !== "area"
      ? existing.preferredArea
      : null);

  return {
    city: city || undefined,
    preferredArea: preferredArea || undefined,
    otherPreferredAreas: parsed.otherPreferredAreas || existing.otherPreferredAreas || undefined,
    minimumArea: parsed.minimumArea || existing.minimumArea || undefined,
    expectedRent: parsed.expectedRent || existing.expectedRent || undefined,
    requirement: parsed.requirement || existing.requirement || undefined,
    kindOfBusiness: parsed.kindOfBusiness || existing.kindOfBusiness || undefined,
    specificRequirements:
      parsed.specificRequirements || existing.specificRequirements || undefined,
  };
}

function getEffectiveRequirements(client = {}) {
  const repaired = repairRequirementsFromRemarks(client.remarks, client);
  return {
    ...client,
    city: repaired.city || client.city,
    preferredArea: repaired.preferredArea || client.preferredArea,
    otherPreferredAreas: repaired.otherPreferredAreas || client.otherPreferredAreas,
    minimumArea: repaired.minimumArea || client.minimumArea,
    expectedRent: repaired.expectedRent || client.expectedRent,
    requirement: repaired.requirement || client.requirement,
    kindOfBusiness: repaired.kindOfBusiness || client.kindOfBusiness,
    specificRequirements: repaired.specificRequirements || client.specificRequirements,
  };
}

function parseLineValue(lines, labels) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const label of labels) {
      const re = new RegExp(`^${label}\\s*[:\\-/]+\\s*(.+)$`, "i");
      const m = trimmed.match(re);
      if (m?.[1]) {
        return m[1].trim().slice(0, 120);
      }
    }
  }
  return null;
}

function parseRequirementsFromEmail(rawText) {
  const replyOnly = stripQuotedReplyContent(rawText);
  const lines = replyOnly.split("\n").map((l) => l.trim()).filter(Boolean);
  const text = lines.join("\n");
  const lower = text.toLowerCase();

  const result = {
    city: null,
    preferredArea: null,
    otherPreferredAreas: null,
    minimumArea: null,
    expectedRent: null,
    requirement: null,
    kindOfBusiness: null,
    specificRequirements: null,
    rawExcerpt: text.slice(0, 500),
  };

  if (!text) return result;

  result.city =
    parseLineValue(lines, ["city", "location"]) ||
    null;

  result.preferredArea =
    parseLineValue(lines, [
      "preferred area",
      "preferred area / locality",
      "locality",
      "preferred location",
      "area",
    ]) || null;

  result.minimumArea =
    parseLineValue(lines, ["required size", "size", "sqft", "area required"]) ||
    null;

  if (result.minimumArea) {
    result.minimumArea = result.minimumArea.replace(/[^\d-–]/g, "").replace(/,/g, "");
  }

  result.expectedRent =
    parseLineValue(lines, [
      "budget / expected rent",
      "budget",
      "expected rent",
      "rent",
    ]) || null;

  if (result.expectedRent) {
    result.expectedRent = result.expectedRent.replace(/[^\d-–]/g, "").replace(/,/g, "");
  }

  result.kindOfBusiness =
    parseLineValue(lines, ["type of business", "business type", "business"]) ||
    null;

  if (result.kindOfBusiness) {
    result.requirement = result.kindOfBusiness;
  }

  if (!result.city) {
    const cityPatterns = [
      /\b(?:in|at)\s+(mumbai|delhi|ncr|gurgaon|noida|pune|bangalore|bengaluru|hyderabad|chennai|ahmedabad|kolkata|jaipur|indore|surat)\b/i,
      /(?:city|location)\s*[:\-]?\s*([a-z][a-z\s]{2,30})/i,
    ];
    for (const pattern of cityPatterns) {
      const m = text.match(pattern);
      if (m?.[1]) {
        result.city = m[1].trim().replace(/\s+(area|for|with).*$/i, "").slice(0, 80);
        break;
      }
    }
  }

  if (!result.minimumArea) {
    const sizeMatch = text.match(/(\d{3,6})\s*(?:sq\.?\s*ft|sqft|square feet)/i);
    if (sizeMatch?.[1]) result.minimumArea = sizeMatch[1];
  }

  if (!result.expectedRent) {
    const rentMatch = text.match(/(?:rs\.?|₹|inr)?\s*(\d{5,9})/i);
    if (rentMatch?.[1]) result.expectedRent = rentMatch[1];
  }

  if (!result.preferredArea) {
    const areaRoad = text.match(
      /\b(sector\s*\d+|andheri|bandra|bkc|varachha|whitefield|hinjewadi|udyog vihar|ring road|hazira|sg highway)\b/i
    );
    if (areaRoad?.[1]) {
      result.preferredArea = areaRoad[1].trim().slice(0, 120);
    }
  }

  if (!result.kindOfBusiness) {
    const businessTypes = [
      ["warehouse", "warehouse"],
      ["logistics", "logistics"],
      ["industrial", "industrial"],
      ["office", "office"],
      ["retail", "retail"],
    ];
    for (const [keyword, label] of businessTypes) {
      if (lower.includes(keyword)) {
        result.kindOfBusiness = label;
        result.requirement = label;
        break;
      }
    }
  }

  return result;
}

/** Minimum fields needed before we can convert + run property matching. */
function isCompleteForConversion(parsed) {
  if (!parsed?.city) return false;
  const hasLocation = Boolean(parsed.preferredArea || parsed.otherPreferredAreas);
  const hasSize = Boolean(parsed.minimumArea || /sqft|sq ft|area|\d{3,}/i.test(parsed.requirement || ""));
  const hasNeed = Boolean(parsed.requirement || parsed.kindOfBusiness);
  return hasLocation && (hasSize || hasNeed);
}

function mergeRequirements(existing, parsed) {
  const out = { ...existing };
  for (const key of [
    "city",
    "preferredArea",
    "otherPreferredAreas",
    "minimumArea",
    "expectedRent",
    "requirement",
    "kindOfBusiness",
    "specificRequirements",
  ]) {
    if (parsed[key] && !out[key]) out[key] = parsed[key];
  }
  return out;
}

module.exports = {
  parseRequirementsFromEmail,
  isCompleteForConversion,
  mergeRequirements,
  cleanText,
  stripQuotedReplyContent,
  extractLatestReplyBlock,
  isMalformedRequirements,
  repairRequirementsFromRemarks,
  getEffectiveRequirements,
  extractCityToken,
};
