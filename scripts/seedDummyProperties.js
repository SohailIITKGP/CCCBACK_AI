/**
 * Seed dummy commercial properties for matching / demo.
 * Run: node scripts/seedDummyProperties.js
 *      node scripts/seedDummyProperties.js --clear   (remove previous seed-* properties first)
 */
require("dotenv").config();

const connectDB = require("../config/db");
const Property = require("../models/propertyModel");
const User = require("../models/User");

const SEED_TAG = "seed-demo";

const DUMMY_PROPERTIES = [
  {
    name: "Andheri East Logistics Hub",
    city: "Mumbai",
    roadName: "Andheri East",
    clusters: ["MIDC", "Andheri East"],
    category: "warehouse",
    exactArea: "5200",
    area: "5000-5500",
    expectedRent: "480000",
    lumsumRent: "480000",
    rentType: "Monthly",
    address: "MIDC Andheri East, Mumbai, Maharashtra 400069",
    floor: "Ground",
    possession: "Immediate",
    owner: "Demo Owner A",
    contact: "9876500001",
  },
  {
    name: "BKC Grade-A Office Suite",
    city: "Mumbai",
    roadName: "Bandra Kurla Complex",
    clusters: ["BKC", "Kurla"],
    category: "office",
    exactArea: "1200",
    area: "1000-1500",
    expectedRent: "1500000",
    lumsumRent: "1500000",
    rentType: "Monthly",
    address: "G Block, BKC, Mumbai 400051",
    floor: "12",
    possession: "Immediate",
    owner: "Demo Owner B",
    contact: "9876500002",
  },
  {
    name: "Goregaon Retail High Street",
    city: "Mumbai",
    roadName: "Goregaon West",
    clusters: ["Goregaon", "Link Road"],
    category: "retail",
    exactArea: "800",
    area: "750-900",
    expectedRent: "350000",
    lumsumRent: "350000",
    rentType: "Monthly",
    address: "Link Road, Goregaon West, Mumbai 400104",
    floor: "Ground",
    frontageRoad: "Main Road",
    possession: "Immediate",
    owner: "Demo Owner C",
    contact: "9876500003",
  },
  {
    name: "Surat Varachha Office Space",
    city: "Surat",
    roadName: "Varachha",
    clusters: ["Varachha", "Ring Road"],
    category: "office",
    exactArea: "1100",
    area: "1000-1200",
    expectedRent: "450000",
    lumsumRent: "450000",
    rentType: "Monthly",
    address: "Varachha Main Road, Surat, Gujarat 395006",
    floor: "3",
    possession: "Immediate",
    owner: "Demo Owner D",
    contact: "9876500004",
  },
  {
    name: "Surat Industrial Warehouse",
    city: "Surat",
    roadName: "Hazira Road",
    clusters: ["Hazira", "Industrial"],
    category: "warehouse",
    exactArea: "10000",
    area: "9500-10500",
    expectedRent: "650000",
    lumsumRent: "650000",
    rentType: "Monthly",
    address: "Hazira Industrial Area, Surat, Gujarat",
    floor: "Ground",
    docklevelnoQty: "2",
    fireSafety: "Yes",
    possession: "30 days",
    owner: "Demo Owner E",
    contact: "9876500005",
  },
  {
    name: "Surat Ring Road Showroom",
    city: "Surat",
    roadName: "Ring Road",
    clusters: ["Ring Road", "Adajan"],
    category: "retail",
    exactArea: "1500",
    area: "1400-1600",
    expectedRent: "520000",
    lumsumRent: "520000",
    rentType: "Monthly",
    address: "Ring Road, Surat, Gujarat 395009",
    floor: "Ground + Mezzanine",
    frontageRoad: "Ring Road",
    possession: "Immediate",
    owner: "Demo Owner F",
    contact: "9876500006",
  },
  {
    name: "Gurgaon Udyog Vihar Office",
    city: "Gurgaon",
    roadName: "Udyog Vihar",
    clusters: ["Udyog Vihar", "Phase 4"],
    category: "office",
    exactArea: "2500",
    area: "2400-2600",
    expectedRent: "900000",
    lumsumRent: "900000",
    rentType: "Monthly",
    address: "Udyog Vihar Phase 4, Gurgaon, Haryana 122016",
    floor: "5",
    possession: "Immediate",
    owner: "Demo Owner G",
    contact: "9876500007",
  },
  {
    name: "Noida Sector 62 IT Office",
    city: "Noida",
    roadName: "Sector 62",
    clusters: ["Sector 62", "Noida"],
    category: "office",
    exactArea: "1800",
    area: "1700-2000",
    expectedRent: "720000",
    lumsumRent: "720000",
    rentType: "Monthly",
    address: "Sector 62, Noida, UP 201309",
    floor: "8",
    possession: "Immediate",
    owner: "Demo Owner H",
    contact: "9876500008",
  },
  {
    name: "Pune Hinjewadi Warehouse",
    city: "Pune",
    roadName: "Hinjewadi",
    clusters: ["Hinjewadi", "Phase 1"],
    category: "warehouse",
    exactArea: "8000",
    area: "7500-8500",
    expectedRent: "420000",
    lumsumRent: "420000",
    rentType: "Monthly",
    address: "Hinjewadi Phase 1, Pune, Maharashtra",
    floor: "Ground",
    possession: "Immediate",
    owner: "Demo Owner I",
    contact: "9876500009",
  },
  {
    name: "Bangalore Whitefield Office",
    city: "Bangalore",
    roadName: "Whitefield",
    clusters: ["Whitefield", "ITPL"],
    category: "office",
    exactArea: "3000",
    area: "2800-3200",
    expectedRent: "1100000",
    lumsumRent: "1100000",
    rentType: "Monthly",
    address: "Whitefield Main Road, Bangalore, Karnataka",
    floor: "6",
    possession: "Immediate",
    owner: "Demo Owner J",
    contact: "9876500010",
  },
  {
    name: "Ahmedabad SG Highway Retail",
    city: "Ahmedabad",
    roadName: "SG Highway",
    clusters: ["SG Highway", "Satellite"],
    category: "retail",
    exactArea: "2000",
    area: "1900-2100",
    expectedRent: "580000",
    lumsumRent: "580000",
    rentType: "Monthly",
    address: "SG Highway, Ahmedabad, Gujarat",
    floor: "Ground",
    possession: "Immediate",
    owner: "Demo Owner K",
    contact: "9876500011",
  },
  {
    name: "Chennai OMR Industrial Unit",
    city: "Chennai",
    roadName: "OMR",
    clusters: ["OMR", "Perungudi"],
    category: "industrial",
    exactArea: "6000",
    area: "5500-6500",
    expectedRent: "390000",
    lumsumRent: "390000",
    rentType: "Monthly",
    address: "Old Mahabalipuram Road, Chennai, Tamil Nadu",
    floor: "Ground",
    possession: "Immediate",
    owner: "Demo Owner L",
    contact: "9876500012",
  },
];

async function resolveCreatorId() {
  const user =
    (await User.findOne({ role: "Super Admin", status: "Active" }).select("_id").lean()) ||
    (await User.findOne({ status: "Active" }).select("_id").lean());
  return user?._id || null;
}

async function main() {
  const clear = process.argv.includes("--clear");

  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI not set in .env");
    process.exit(1);
  }

  await connectDB();
  const creatorId = await resolveCreatorId();

  if (clear) {
    const removed = await Property.deleteMany({
      propertySourceName: SEED_TAG,
    });
    console.log(`Removed ${removed.deletedCount} previous seed properties (${SEED_TAG})`);
  }

  const existing = await Property.countDocuments({ propertySourceName: SEED_TAG });
  if (existing > 0 && !clear) {
    console.log(`${existing} seed properties already exist. Run with --clear to replace.`);
    process.exit(0);
  }

  const docs = DUMMY_PROPERTIES.map((p) => ({
    ...p,
    propertySourceName: SEED_TAG,
    propertyStatus: "approved",
    isVisibility: true,
    isArchive: false,
    isRead: false,
    whoCreated: creatorId,
    submissionNote: "Dummy data for CRM property matching demo",
  }));

  const inserted = await Property.insertMany(docs);

  console.log(`\nInserted ${inserted.length} dummy properties (tag: ${SEED_TAG})\n`);
  console.log("City breakdown:");
  const byCity = inserted.reduce((acc, p) => {
    acc[p.city] = (acc[p.city] || 0) + 1;
    return acc;
  }, {});
  Object.entries(byCity).forEach(([city, n]) => console.log(`  ${city}: ${n}`));

  console.log("\nSample — client wants Surat office ~1200 sqft:");
  console.log("  -> Surat Varachha Office Space (1100 sqft, office, Rs 4.5L)");
  console.log("\nSample — client wants Mumbai warehouse ~5000 sqft:");
  console.log("  -> Andheri East Logistics Hub (5200 sqft, warehouse, Rs 4.8L)\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => setTimeout(() => process.exit(0), 500));
