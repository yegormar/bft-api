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
 * Build response sequence for three-step flow (one attempt that passes critique).
 * Order: Step 1 (plain text), critique (one sentence), judge (PASS or FAIL), Step 3 (JSON question with dimensionScores).
 * @param {string} step1PlainText - Step 1 response with TITLE:, SITUATION:, OPTIONS:
 * @param {string} critiqueSentence - What would a 16yo think it measures (one sentence)
 * @param {string} judgeAnswer - "PASS" or "FAIL"
 * @param {object} step3Question - Full question: { title, description, type, options: [{ text, value, dimensionScores }] }
 * @returns {Array<string>} [step1, critique, judge, step3]
 */
function threeStepResponses(step1PlainText, critiqueSentence, judgeAnswer, step3Question) {
  return [
    step1PlainText,
    critiqueSentence,
    judgeAnswer,
    JSON.stringify(step3Question),
  ];
}

module.exports = {
  createFakeOllama,
  threeStepResponses,
};
