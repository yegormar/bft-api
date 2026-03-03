/**
 * LLM readiness check: validates that the model is loaded and communication works.
 * Sends a minimal chat request so the backend keeps the model in memory (keep-alive).
 * Used at server startup and on a configurable interval.
 */

const ollamaClient = require('./ollamaClient');

/** Minimal user message used for checkup; triggers a short response and keeps model loaded. */
const CHECKUP_MESSAGE = 'Hi';

/**
 * Run one LLM checkup: call the model with a minimal message to verify connectivity and keep it loaded.
 * @returns {Promise<void>} Resolves if the LLM responds; rejects with an Error on failure.
 */
async function runLlmCheckup() {
  if (!ollamaClient.config.enabled) {
    throw new Error('LLM checkup skipped: Ollama is not configured or not enabled.');
  }
  await ollamaClient.chat([{ role: 'user', content: CHECKUP_MESSAGE }], { quiet: true });
}

module.exports = {
  runLlmCheckup,
};
