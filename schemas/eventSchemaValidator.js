const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, strict: false });
const schemaCache = new Map();

function loadSchema(eventType, version) {
  const key = `${eventType}.v${version}`;
  if (schemaCache.has(key)) {
    return schemaCache.get(key);
  }

  const fileName = `${eventType}.v${version}.json`;
  const filePath = path.join(__dirname, "events", fileName);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const { eventType: _et, version: _v, ...jsonSchema } = raw;
  schemaCache.set(key, jsonSchema);
  return jsonSchema;
}

function validateEventPayload(eventType, version, payload) {
  const jsonSchema = loadSchema(eventType, version);
  if (!jsonSchema) {
    return { valid: true, skipped: true };
  }

  const validate = ajv.compile(jsonSchema);
  const valid = validate(payload);
  if (valid) {
    return { valid: true };
  }

  return {
    valid: false,
    errors: validate.errors,
  };
}

module.exports = {
  validateEventPayload,
  loadSchema,
};
