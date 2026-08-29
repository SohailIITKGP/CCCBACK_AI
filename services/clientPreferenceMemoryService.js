const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const ClientPreferenceMemory = require("../models/ClientPreferenceMemory");
const { enqueueOutboxEvent } = require("./outboxService");
const { isOrchestrationEnabled } = require("../config/orchestration");
const {
  MEMORY_SCORE,
  PREFERENCE_TYPES,
  PREFERENCE_SOURCES,
  CATEGORY_KEYWORDS,
} = require("../config/preferenceMemory");
const { normalizeText, parseNumeric } = require("../config/matchingRules");

async function getOrCreateMemory(clientId, correlationId = null) {
  let doc = await ClientPreferenceMemory.findOne({ clientId });
  if (!doc) {
    doc = await ClientPreferenceMemory.create({
      clientId,
      correlationId,
      entries: [],
    });
  } else if (correlationId && !doc.correlationId) {
    doc.correlationId = correlationId;
    await doc.save();
  }
  return doc;
}

function activeEntries(memory) {
  return (memory?.entries || []).filter((e) => e.active !== false);
}

async function emitPreferenceLearned(clientId, correlationId, entry, userId) {
  if (!isOrchestrationEnabled() || !correlationId) return;

  await enqueueOutboxEvent({
    eventType: "client.preference_learned",
    aggregateType: "Client",
    aggregateId: clientId,
    correlationId,
    schemaVersion: 1,
    metadata: { actor: userId ? "user" : "system", actorId: userId || null },
    payload: {
      clientId: clientId.toString(),
      correlationId,
      type: entry.type,
      value: entry.value,
      propertyId: entry.propertyId?.toString?.() || entry.propertyId || null,
      source: entry.source,
      evidence: entry.evidence?.slice(0, 200),
    },
  });
}

async function addPreferenceEntry({
  clientId,
  correlationId = null,
  type,
  value = "",
  propertyId = null,
  source = "system",
  evidence = "",
  confidence = 0.75,
  userId = null,
  dedupe = true,
}) {
  if (!clientId || !PREFERENCE_TYPES.has(type)) {
    return { error: "invalid_input" };
  }
  if (!PREFERENCE_SOURCES.has(source)) {
    return { error: "invalid_source" };
  }

  const client = await Client.findById(clientId).select("correlationId name").lean();
  if (!client) return { error: "client_not_found" };

  const corr = correlationId || client.correlationId;
  const memory = await getOrCreateMemory(clientId, corr);

  if (dedupe) {
    const duplicate = activeEntries(memory).find(
      (e) =>
        e.type === type &&
        String(e.value || "").toLowerCase() === String(value || "").toLowerCase() &&
        String(e.propertyId || "") === String(propertyId || "")
    );
    if (duplicate) {
      return { skipped: true, reason: "duplicate", entry: duplicate };
    }
  }

  const entry = {
    type,
    value: String(value || "").trim(),
    propertyId: propertyId || null,
    source,
    evidence: String(evidence || "").slice(0, 500),
    confidence: Math.max(0, Math.min(1, confidence)),
    active: true,
    createdBy: userId || null,
  };

  memory.entries.push(entry);
  await memory.save();

  const saved = memory.entries[memory.entries.length - 1];
  await emitPreferenceLearned(clientId, corr, saved, userId);

  return { success: true, entry: saved, memory };
}

function parsePreferencesFromActivityNote(note = "") {
  const text = String(note);
  const parsed = [];

  for (const rule of CATEGORY_KEYWORDS) {
    if (!rule.pattern.test(text)) continue;
    if (rule.type === "price_sensitive") {
      parsed.push({ type: "price_sensitive", value: "high_rent_averse", evidence: text.slice(0, 120) });
    } else if (rule.avoid) {
      parsed.push({ type: "category_avoid", value: rule.value, evidence: text.slice(0, 120) });
    } else {
      parsed.push({ type: "category_prefer", value: rule.value, evidence: text.slice(0, 120) });
    }
  }

  const preferMatch = text.match(/\b(?:prefers?|only wants?|looking for)\s+([a-z\s]{3,30})/i);
  if (preferMatch?.[1]) {
    parsed.push({
      type: "category_prefer",
      value: preferMatch[1].trim().toLowerCase(),
      evidence: text.slice(0, 120),
    });
  }

  const avoidMatch = text.match(/\b(?:avoid|reject(?:ed)?|don'?t want)\s+([a-z\s]{3,30})/i);
  if (avoidMatch?.[1]) {
    parsed.push({
      type: "category_avoid",
      value: avoidMatch[1].trim().toLowerCase(),
      evidence: text.slice(0, 120),
    });
  }

  const areaMatch = text.match(/\b(?:prefers?|only)\s+(?:sector|area)\s+([a-z0-9\s.-]{2,40})/i);
  if (areaMatch?.[1]) {
    parsed.push({
      type: "area_prefer",
      value: areaMatch[1].trim(),
      evidence: text.slice(0, 120),
    });
  }

  return parsed;
}

async function recordFromPropertyOverride({
  clientId,
  correlationId,
  overrideReason,
  aiPropertyId,
  newPropertyId,
  aiScore,
  newPropertyScore,
  userId,
}) {
  const results = [];

  if (newPropertyId) {
    results.push(
      await addPreferenceEntry({
        clientId,
        correlationId,
        type: "property_preferred",
        propertyId: newPropertyId,
        value: overrideReason || "employee_choice",
        source: "override",
        evidence: `Employee linked property (override reason: ${overrideReason || "n/a"})`,
        confidence: 0.9,
        userId,
      })
    );
  }

  if (aiPropertyId && String(aiPropertyId) !== String(newPropertyId)) {
    results.push(
      await addPreferenceEntry({
        clientId,
        correlationId,
        type: "property_rejected",
        propertyId: aiPropertyId,
        value: "ai_suggestion_overridden",
        source: "override",
        evidence: `AI pick overridden (AI score ${aiScore ?? "?"}, new score ${newPropertyScore ?? "?"})`,
        confidence: 0.85,
        userId,
      })
    );
  }

  if (overrideReason === "client_preference") {
    results.push(
      await addPreferenceEntry({
        clientId,
        correlationId,
        type: "feature_note",
        value: "client_preference_override",
        source: "override",
        evidence: "Employee confirmed client preference over AI match",
        confidence: 0.8,
        userId,
      })
    );
  }

  return results;
}

async function recordFromClientIntent({ clientId, correlationId, intentId, text, propertyIds = [] }) {
  const results = [];

  if (intentId === "want_cheaper") {
    const client = await Client.findById(clientId).select("expectedRent").lean();
    const current = parseNumeric(client?.expectedRent);
    const ceiling = current ? Math.round(current * 0.85) : null;

    results.push(
      await addPreferenceEntry({
        clientId,
        correlationId,
        type: "price_sensitive",
        value: "wants_cheaper",
        source: "client_reply",
        evidence: text?.slice(0, 200) || "Client asked for cheaper options",
        confidence: 0.82,
      })
    );

    if (ceiling) {
      results.push(
        await addPreferenceEntry({
          clientId,
          correlationId,
          type: "price_ceiling",
          value: String(ceiling),
          source: "client_reply",
          evidence: `Derived ceiling from budget ~₹${current}`,
          confidence: 0.7,
        })
      );
    }
  }

  if (intentId === "want_another_option" && propertyIds.length > 1) {
    results.push(
      await addPreferenceEntry({
        clientId,
        correlationId,
        type: "property_rejected",
        propertyId: propertyIds[0],
        value: "client_chose_other_option",
        source: "client_reply",
        evidence: text?.slice(0, 200) || "Client requested alternate property",
        confidence: 0.78,
      })
    );

    if (propertyIds[1]) {
      results.push(
        await addPreferenceEntry({
          clientId,
          correlationId,
          type: "property_preferred",
          propertyId: propertyIds[1],
          value: "client_selected_option",
          source: "client_reply",
          evidence: "Client selected alternate from shared list",
          confidence: 0.8,
        })
      );
    }
  }

  if (intentId === "not_interested" && propertyIds[0]) {
    results.push(
      await addPreferenceEntry({
        clientId,
        correlationId,
        type: "property_rejected",
        propertyId: propertyIds[0],
        value: "not_interested",
        source: "client_reply",
        evidence: text?.slice(0, 200) || "Client not interested",
        confidence: 0.88,
      })
    );
  }

  return results;
}

async function recordFromActivityNote({ clientId, correlationId, note, userId }) {
  const parsed = parsePreferencesFromActivityNote(note);
  const results = [];

  for (const item of parsed) {
    results.push(
      await addPreferenceEntry({
        clientId,
        correlationId,
        type: item.type,
        value: item.value,
        source: "employee_activity",
        evidence: item.evidence,
        confidence: 0.72,
        userId,
      })
    );
  }

  return results;
}

function getRejectedPropertyIds(memory) {
  return activeEntries(memory)
    .filter((e) => e.type === "property_rejected" && e.propertyId)
    .map((e) => String(e.propertyId));
}

function getPriceCeiling(memory) {
  const ceilings = activeEntries(memory)
    .filter((e) => e.type === "price_ceiling" && e.value)
    .map((e) => parseNumeric(e.value))
    .filter((n) => n != null);
  if (!ceilings.length) return null;
  return Math.min(...ceilings);
}

function applyMemoryAdjustments(baseResult, property, memory) {
  if (!memory || !property) return baseResult;

  const entries = activeEntries(memory);
  if (!entries.length) return baseResult;

  let delta = 0;
  const memoryNotes = [];
  const propId = property._id?.toString?.() || String(property._id || "");
  const propCat = normalizeText(property.category);
  const propRoad = normalizeText(property.roadName);
  const propRent = parseNumeric(property.expectedRent) ?? parseNumeric(property.lumsumRent);
  const ceiling = getPriceCeiling(memory);
  const priceSensitive = entries.some((e) => e.type === "price_sensitive");

  for (const entry of entries) {
    const val = normalizeText(entry.value);

    if (entry.type === "property_preferred" && entry.propertyId && String(entry.propertyId) === propId) {
      delta += MEMORY_SCORE.propertyPreferred;
      memoryNotes.push("Previously preferred property (+memory)");
    }

    if (entry.type === "category_prefer" && val && propCat && (propCat.includes(val) || val.includes(propCat))) {
      delta += MEMORY_SCORE.categoryPrefer;
      memoryNotes.push(`Prefers ${entry.value} (+memory)`);
    }

    if (entry.type === "category_avoid" && val && propCat && (propCat.includes(val) || val.includes(propCat))) {
      delta += MEMORY_SCORE.categoryAvoid;
      memoryNotes.push(`Avoids ${entry.value} (−memory)`);
    }

    if (entry.type === "area_prefer" && val && propRoad && (propRoad.includes(val) || val.includes(propRoad))) {
      delta += MEMORY_SCORE.areaPrefer;
      memoryNotes.push(`Prefers area ${entry.value} (+memory)`);
    }

    if (entry.type === "area_avoid" && val && propRoad && (propRoad.includes(val) || val.includes(propRoad))) {
      delta += MEMORY_SCORE.areaAvoid;
      memoryNotes.push(`Avoids area ${entry.value} (−memory)`);
    }
  }

  if (ceiling != null && propRent != null && propRent > ceiling) {
    delta += MEMORY_SCORE.priceAboveCeiling;
    memoryNotes.push(`Above learned price ceiling ₹${ceiling} (−memory)`);
  } else if (priceSensitive && propRent != null && ceiling == null) {
    const clientMid = baseResult.filtersApplied?.expectedRent;
    const range = require("../config/matchingRules").parseRentRange(clientMid);
    if (range.max != null && propRent > range.max * 1.05) {
      delta += MEMORY_SCORE.priceSensitivePenalty;
      memoryNotes.push("Price-sensitive client — rent high (−memory)");
    }
  }

  const adjustedScore = Math.max(0, Math.min(100, baseResult.score + delta));
  const explanation = [baseResult.explanation, ...memoryNotes].filter(Boolean).join("; ");

  return {
    ...baseResult,
    score: adjustedScore,
    baseScore: baseResult.score,
    memoryDelta: delta,
    explanation,
    memoryApplied: memoryNotes.length > 0,
  };
}

async function loadMemoryForClient(clientId) {
  return ClientPreferenceMemory.findOne({ clientId }).lean();
}

async function getClientPreferences(clientId) {
  const memory = await loadMemoryForClient(clientId);
  const entries = activeEntries(memory)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((e) => ({
      _id: e._id,
      type: e.type,
      value: e.value,
      propertyId: e.propertyId,
      source: e.source,
      evidence: e.evidence,
      confidence: e.confidence,
      createdAt: e.createdAt,
    }));

  return {
    clientId,
    correlationId: memory?.correlationId || null,
    entries,
    rejectedPropertyIds: getRejectedPropertyIds(memory),
    priceCeiling: getPriceCeiling(memory),
  };
}

async function deactivatePreferenceEntry(clientId, entryId, userId) {
  const memory = await ClientPreferenceMemory.findOne({ clientId });
  if (!memory) return { error: "not_found" };

  const entry = memory.entries.id(entryId);
  if (!entry) return { error: "entry_not_found" };

  entry.active = false;
  await memory.save();

  return { success: true, entryId };
}

async function getPreferenceAnalytics({ days = 90 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await ClientPreferenceMemory.find({ updatedAt: { $gte: since } }).lean();

  const byType = {};
  const bySource = {};
  let totalEntries = 0;

  for (const row of rows) {
    for (const entry of activeEntries(row)) {
      if (new Date(entry.createdAt) < since) continue;
      totalEntries += 1;
      byType[entry.type] = (byType[entry.type] || 0) + 1;
      bySource[entry.source] = (bySource[entry.source] || 0) + 1;
    }
  }

  return {
    periodDays: days,
    clientsWithMemory: rows.length,
    totalActiveEntries: totalEntries,
    byType: Object.entries(byType)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    bySource: Object.entries(bySource)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count),
  };
}

module.exports = {
  addPreferenceEntry,
  recordFromPropertyOverride,
  recordFromClientIntent,
  recordFromActivityNote,
  parsePreferencesFromActivityNote,
  loadMemoryForClient,
  getClientPreferences,
  deactivatePreferenceEntry,
  getRejectedPropertyIds,
  applyMemoryAdjustments,
  getPreferenceAnalytics,
  activeEntries,
};
