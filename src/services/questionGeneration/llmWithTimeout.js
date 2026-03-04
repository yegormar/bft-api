/**
 * Call LLM to generate a scenario question with a timeout.
 * On timeout or LLM error, returns null so the caller can use store fallback.
 *
 * @param {Array<object>} dimensionSet
 * @param {string[]} askedQuestionTitles
 * @param {Array<object>} answers
 * @param {object | null} preSurveyProfile
 * @param {number} timeoutMs - must be > 0 (caller reads from config)
 * @param {function} generateFn - (dimensionSet, askedQuestionTitles, answers, preSurveyProfile, preferredResponseType?) => Promise<{ nextQuestion, assessmentSummary }>
 * @param {string | null} [preferredResponseType] - optional hint: single_choice, multi_choice, or rank
 * @returns {Promise<{ nextQuestion: object | null, assessmentSummary: string | null } | null>}
 */
async function generateScenarioQuestionWithTimeout(
  dimensionSet,
  askedQuestionTitles,
  answers,
  preSurveyProfile,
  timeoutMs,
  generateFn,
  preferredResponseType = null
) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), timeoutMs)
  );
  try {
    const result = await Promise.race([
      generateFn(dimensionSet, askedQuestionTitles, answers, preSurveyProfile, preferredResponseType),
      timeoutPromise,
    ]);
    return result;
  } catch {
    return null;
  }
}

module.exports = { generateScenarioQuestionWithTimeout };
