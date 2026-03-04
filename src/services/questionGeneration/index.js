/**
 * Question generation component: FIFO queue, LLM with timeout, store fallback.
 * Single entry point: requestQuestion(context) => Promise<{ question, dimensionSet, assessmentSummary, source } | null>
 */

const ollamaClient = require('../../lib/ollamaClient');
const ollamaInterview = require('../../lib/ollamaInterview');
const questionStore = require('../questionStore');
const { getQuestionGenConfig } = require('../../../config/questionGeneration');
const { selectBestFromStore } = require('./storeFallback');
const { generateScenarioQuestionWithTimeout } = require('./llmWithTimeout');
const { createQueue } = require('./queue');

function createProcessor() {
  return async function processOne(context) {
    const { timeoutMs } = getQuestionGenConfig();
    const {
      desiredDimensionSet,
      askedQuestionTitles,
      answers,
      preSurveyProfile,
      storeDir,
      bftUserId,
      preferredResponseType,
    } = context;

    if (ollamaClient.config.enabled) {
      const llmResult = await generateScenarioQuestionWithTimeout(
        desiredDimensionSet,
        askedQuestionTitles || [],
        answers || [],
        preSurveyProfile ?? null,
        timeoutMs,
        ollamaInterview.generateScenarioQuestion,
        preferredResponseType ?? null
      );
      if (llmResult && llmResult.nextQuestion && typeof llmResult.nextQuestion === 'object' && llmResult.nextQuestion.title) {
        return {
          question: llmResult.nextQuestion,
          dimensionSet: desiredDimensionSet,
          assessmentSummary: llmResult.assessmentSummary ?? null,
          source: 'llm',
        };
      }
    }

    if (storeDir) {
      const profileKey = questionStore.getProfileKey(preSurveyProfile);
      const usedSet = questionStore.getUsedSet(storeDir, bftUserId);
      const candidates = questionStore.listByProfile(storeDir, profileKey);
      const fallback = selectBestFromStore(
        candidates,
        usedSet,
        desiredDimensionSet
      );
      if (fallback) {
        return {
          question: fallback.question,
          dimensionSet: fallback.dimensionSet,
          assessmentSummary: fallback.assessmentSummary,
          source: 'store',
        };
      }
    }

    return null;
  };
}

const queue = createQueue(createProcessor());

/**
 * Request a question for the given context. Enqueues to FIFO; when processed, tries LLM with timeout then store fallback.
 * @param {object} context - { sessionId, bftUserId, preSurveyProfile, storeDir, desiredDimensionSet, askedQuestionTitles, answers }
 * @returns {Promise<{ question: object, dimensionSet: Array<object>, assessmentSummary: string | null, source: 'llm'|'store' } | null>}
 */
async function requestQuestion(context) {
  return queue.enqueue(context);
}

module.exports = {
  requestQuestion,
  getQuestionGenConfig,
};
