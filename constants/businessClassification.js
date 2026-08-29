/** Shared classification options for Lead + Client (property-aligned clusters). */

const CLUSTER_OPTIONS = Object.freeze([
  "F&B",
  "RETAIL",
  "LOCAL",
  "JEWELRY",
  "CORPORATE PARKS",
  "RESIDENTIAL",
  "SCHOOL AND COLLEGES",
  "DRIVE THRU",
]);

const FORMAT_OPTIONS = Object.freeze([
  "High Level",
  "Medium Level",
  "Affordable",
]);

const KIND_OF_BUSINESS_OPTIONS = Object.freeze([
  "MBO",
  "EBO",
  "Women clothing brand",
  "Men clothing brands",
  "Ethenic wear brands",
  "Jewellery brands",
  "Sports brands",
  "Footwear brands",
  "Bags & accessories brands",
  "Food brands",
  "Large format",
  "Kids brand",
  "Cosmetic brand",
  "Automobile",
  "Electronics",
  "Salon brands",
  "Home furnished brands",
  "Hotels brands",
  "Superstores",
  "Banks",
  "EYEWEAR",
  "Unisex Clothing",
  "Hospital",
  "School",
  "Co-working",
  "Office Space",
  "Others",
]);

const CLUSTER_SET = new Set(CLUSTER_OPTIONS);
const FORMAT_SET = new Set(FORMAT_OPTIONS);
const KIND_OF_BUSINESS_SET = new Set(KIND_OF_BUSINESS_OPTIONS);

function sanitizeClusters(input) {
  if (input == null || input === "") return [];
  const list = Array.isArray(input) ? input : [input];
  const unique = [];
  const seen = new Set();
  for (const raw of list) {
    const value = String(raw || "").trim();
    if (!value || !CLUSTER_SET.has(value) || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function sanitizeFormat(input) {
  if (input == null || input === "") return undefined;
  const value = String(input).trim();
  return FORMAT_SET.has(value) ? value : undefined;
}

function sanitizeKindOfBusiness(input) {
  if (input == null || input === "") return undefined;
  const value = String(input).trim();
  return KIND_OF_BUSINESS_SET.has(value) ? value : undefined;
}

module.exports = {
  CLUSTER_OPTIONS,
  FORMAT_OPTIONS,
  KIND_OF_BUSINESS_OPTIONS,
  sanitizeClusters,
  sanitizeFormat,
  sanitizeKindOfBusiness,
};
