'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generateScenarioQuestionWithTimeout } = require('../../src/services/questionGeneration/llmWithTimeout');

describe('questionGeneration/llmWithTimeout', () => {
  describe('generateScenarioQuestionWithTimeout', () => {
    const dimensionSet = [{ dimensionType: 'trait', dimensionId: 'adaptability' }];
    const askedQuestionTitles = [];
    const answers = [];
    const preSurveyProfile = null;

    it('returns LLM result when it resolves before timeout', async () => {
      const expected = { nextQuestion: { title: 'Test?' }, assessmentSummary: 'ok' };
      const generateFn = async () => expected;
      const result = await generateScenarioQuestionWithTimeout(
        dimensionSet,
        askedQuestionTitles,
        answers,
        preSurveyProfile,
        5000,
        generateFn
      );
      assert.strictEqual(result, expected);
    });

    it('returns null when LLM rejects', async () => {
      const generateFn = async () => {
        throw new Error('LLM error');
      };
      const result = await generateScenarioQuestionWithTimeout(
        dimensionSet,
        askedQuestionTitles,
        answers,
        preSurveyProfile,
        5000,
        generateFn
      );
      assert.strictEqual(result, null);
    });

    it('returns null when LLM exceeds timeout', async () => {
      const generateFn = async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { nextQuestion: { title: 'Late' }, assessmentSummary: null };
      };
      const result = await generateScenarioQuestionWithTimeout(
        dimensionSet,
        askedQuestionTitles,
        answers,
        preSurveyProfile,
        50,
        generateFn
      );
      assert.strictEqual(result, null);
    });
  });
});
