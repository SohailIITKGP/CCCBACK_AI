/**
 * Agent orchestration feature flags.
 * Phase 0: event outbox + workers. Set AGENT_ORCHESTRATION_ENABLED=false to disable emits.
 */
function isOrchestrationEnabled() {
  if (process.env.AGENT_ORCHESTRATION_ENABLED === "false") {
    return false;
  }
  return Boolean(process.env.REDIS_URL);
}

module.exports = {
  isOrchestrationEnabled,
};
