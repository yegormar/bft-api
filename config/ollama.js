/**
 * Ollama-specific config. Derived from config/llm.js when provider is ollama or ollama_cloud.
 * Kept for backward compatibility; new code may use config/llm.js directly.
 */

const llm = require('./llm');

const useOllama = llm.provider === 'ollama' || llm.provider === 'ollama_cloud';

module.exports = {
  mode: llm.provider === 'ollama_cloud' ? 'cloud' : 'local',
  baseUrl: llm.baseUrl,
  apiKey: llm.apiKey,
  model: llm.model,
  get enabled() {
    return useOllama && llm.enabled;
  },
};
