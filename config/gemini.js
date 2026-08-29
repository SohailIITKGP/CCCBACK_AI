/** Shared Gemini model name — override with GEMINI_MODEL in .env */
function getGeminiModelName() {
  return process.env.GEMINI_MODEL || "gemini-pro";
}

module.exports = {
  getGeminiModelName,
};
