/** Score adjustments when applying client preference memory to property matching. */
const MEMORY_SCORE = {
  propertyPreferred: 12,
  categoryPrefer: 10,
  areaPrefer: 8,
  categoryAvoid: -18,
  areaAvoid: -14,
  priceAboveCeiling: -22,
  priceSensitivePenalty: -10,
};

const PREFERENCE_TYPES = new Set([
  "category_prefer",
  "category_avoid",
  "area_prefer",
  "area_avoid",
  "property_rejected",
  "property_preferred",
  "price_ceiling",
  "price_sensitive",
  "feature_note",
]);

const PREFERENCE_SOURCES = new Set([
  "override",
  "client_reply",
  "employee_activity",
  "manual",
  "system",
]);

/** Keywords in activity notes → category preference */
const CATEGORY_KEYWORDS = [
  { pattern: /\bmall\b/i, value: "mall" },
  { pattern: /\bwarehouse\b/i, value: "warehouse" },
  { pattern: /\bretail\b/i, value: "retail" },
  { pattern: /\boffice\b/i, value: "office" },
  { pattern: /\bindustrial\b/i, value: "industrial" },
  { pattern: /\broadside\b/i, value: "roadside", avoid: true },
  { pattern: /\bhigh\s*rent\b/i, type: "price_sensitive" },
  { pattern: /\bcheaper\b/i, type: "price_sensitive" },
];

module.exports = {
  MEMORY_SCORE,
  PREFERENCE_TYPES,
  PREFERENCE_SOURCES,
  CATEGORY_KEYWORDS,
};
