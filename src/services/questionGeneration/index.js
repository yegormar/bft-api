/**
 * Question generation component: FIFO queue, LLM with timeout, store fallback.
 * Single entry point: requestQuestion(context) => Promise<{ question, dimensionSet?, assessmentSummary?, source? } | { question: null, reason: string }>
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
      sessionId,
      desiredDimensionSet,
      askedQuestionTitles,
      answers,
      preSurveyProfile,
      storeDir,
      bftUserId,
      preferredResponseType,
      batchTheme,
      dilemmaAnchor,
    } = context;

    let nullReason = null;

    if (ollamaClient.config.enabled) {
      const llmResult = await generateScenarioQuestionWithTimeout(
        desiredDimensionSet,
        askedQuestionTitles || [],
        answers || [],
        preSurveyProfile ?? null,
        timeoutMs,
        ollamaInterview.generateScenarioQuestion,
        preferredResponseType ?? null,
        batchTheme ?? null,
        dilemmaAnchor ?? null
      );
      if (llmResult && llmResult.nextQuestion && typeof llmResult.nextQuestion === 'object' && llmResult.nextQuestion.title) {
        return {
          question: llmResult.nextQuestion,
          dimensionSet: Array.isArray(llmResult.dimensionSet) && llmResult.dimensionSet.length > 0 ? llmResult.dimensionSet : desiredDimensionSet,
          assessmentSummary: llmResult.assessmentSummary ?? null,
          source: 'llm',
        };
      }
      if (!llmResult) {
        nullReason = 'LLM returned null (timeout or error; check for [bft] question generation timed out / failed above)';
      } else {
        nullReason = 'LLM result invalid (missing nextQuestion or title)';
      }
    } else {
      nullReason = 'LLM disabled';
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
      nullReason = (nullReason ? nullReason + '; ' : '') + 'store had no unused question for this profile';
    } else {
      nullReason = (nullReason ? nullReason + '; ' : '') + 'store not configured (no storeDir)';
    }

    console.warn('[bft] question generator returning null sessionId=%s reason=%s', sessionId || '(no sessionId)', nullReason);
    return { question: null, reason: nullReason };
  };
}

const queue = createQueue(createProcessor());

/**
 * Request a question for the given context. Enqueues to FIFO; when processed, tries LLM with timeout then store fallback.
 * @param {object} context - { sessionId, bftUserId, preSurveyProfile, storeDir, desiredDimensionSet, askedQuestionTitles, answers }
 * @returns {Promise<{ question: object, dimensionSet: Array<object>, assessmentSummary: string | null, source: 'llm'|'store' } | { question: null, reason: string }>}
 */
async function requestQuestion(context) {
  return queue.enqueue(context);
}

module.exports = {
  requestQuestion,
  getQuestionGenConfig,
};
