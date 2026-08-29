/**
 * Legacy ML stubs — TensorFlow removed for Vercel/serverless compatibility.
 * Training scripts in ml/ are dev-only and excluded from Vercel deploys.
 */

function createModel() {
  throw new Error(
    "TensorFlow model training is disabled. Use propertyMatchingService (rule-based) instead."
  );
}

async function predict() {
  return 0;
}

module.exports = { createModel, predict };
