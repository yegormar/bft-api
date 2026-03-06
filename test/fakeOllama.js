/**
 * Fake Ollama client for unit tests. Implements the same interface as ollamaClient
 * for the parts used by ollamaInterview (chat, config.enabled). No real LLM calls.
 * Use to validate workflow, edge conditions, and validation without depending on Ollama.
 */

/**
 * Create a fake client that returns predefined responses per chat call.
 * @param {Array<{ content: string }>} responses - One content string (or object with content) per chat() call, in order.
 * @param {{ enabled?: boolean }} [options] - config.enabled (default true).
 * @returns {{ chat: function, config: { enabled: boolean } }}
 */
function createFakeOllama(responses = [], options = {}) {
  const list = Array.isArray(responses) ? responses : [responses];
  let callIndex = 0;
  return {
    chat: async (messages) => {
      const item = list[callIndex];
      callIndex += 1;
      if (item == null) {
        return { content: '' };
      }
      const content = typeof item === 'string' ? item : (item && item.content);
      return { content: content ?? '' };
    },
    config: { enabled: options.enabled !== false },
  };
}

/**
 * Build step 1 response (3 scenarios) and step 2 response (chosen index + optionScores) for two-step flow.
 * @param {object} step1 - { nextQuestions: [ scenario1, scenario2, scenario3 ] }
 * @param {object} step2 - { chosenScenarioIndex: number, optionScores: Array<{ dimensionScores: object }> }
 * @returns {Array<string>} [step1Json, step2Json]
 */
function twoStepResponses(step1, step2) {
  return [JSON.stringify(step1), JSON.stringify(step2)];
}

module.exports = {
  createFakeOllama,
  twoStepResponses,
};
