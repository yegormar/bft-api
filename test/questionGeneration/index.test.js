'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const tmpDir = path.join(os.tmpdir(), `bft-qgen-index-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.BFT_QUESTION_LLM_TIMEOUT_MS = '5000';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const questionStore = require('../../src/services/questionStore');
const questionGenerator = require('../../src/services/questionGeneration');

describe('questionGeneration/index', () => {
  describe('requestQuestion', () => {
    it('returns a question from store or LLM (store when LLM fails/times out, llm when LLM succeeds)', async () => {
      const profile = { dominant: ['test-index'] };
      const profileKey = questionStore.getProfileKey(profile);
      const bftUserId = 'user-index-' + Date.now();
      const question = {
        title: 'Index test question?',
        type: 'single_choice',
        options: [{ text: 'Yes', value: 'y' }, { text: 'No', value: 'n' }],
      };
      const dimensionSet = [
        { dimensionType: 'aptitude', dimensionId: 'logical_analytical_reasoning' },
      ];
      questionStore.save(tmpDir, profileKey, question, dimensionSet, 'Summary');

      const result = await questionGenerator.requestQuestion({
        sessionId: 's1',
        bftUserId,
        preSurveyProfile: profile,
        storeDir: tmpDir,
        desiredDimensionSet: dimensionSet,
        askedQuestionTitles: [],
        answers: [],
      });

      assert.ok(result, 'expected a result (store or LLM)');
      assert.ok(result.source === 'store' || result.source === 'llm');
      assert.ok(result.question && result.question.title);
      if (result.source === 'store') {
        assert.strictEqual(result.question.title, question.title);
        assert.deepStrictEqual(result.dimensionSet, dimensionSet);
        assert.strictEqual(result.assessmentSummary, 'Summary');
      }
    });

    it('returns null or LLM question when store has no unused question (null if LLM fails/times out, source llm if LLM succeeds)', async () => {
      const emptyProfile = { dominant: ['empty-profile-' + Date.now()] };
      const emptyStoreDir = path.join(tmpDir, 'no-questions');
      fs.mkdirSync(emptyStoreDir, { recursive: true });
      const result = await questionGenerator.requestQuestion({
        sessionId: 's2',
        bftUserId: 'u-empty',
        preSurveyProfile: emptyProfile,
        storeDir: emptyStoreDir,
        desiredDimensionSet: [{ dimensionType: 'trait', dimensionId: 'adaptability' }],
        askedQuestionTitles: [],
        answers: [],
      });
      if (result === null) {
        assert.strictEqual(result, null);
      } else {
        assert.strictEqual(result.source, 'llm');
        assert.ok(result.question && result.question.title);
      }
    });
  });

  describe('getQuestionGenConfig', () => {
    it('throws when BFT_QUESTION_LLM_TIMEOUT_MS is unset (used by component on first request)', () => {
      const prev = process.env.BFT_QUESTION_LLM_TIMEOUT_MS;
      delete process.env.BFT_QUESTION_LLM_TIMEOUT_MS;
      try {
        assert.throws(
          () => questionGenerator.getQuestionGenConfig(),
          /BFT_QUESTION_LLM_TIMEOUT_MS is required/
        );
      } finally {
        if (prev !== undefined) process.env.BFT_QUESTION_LLM_TIMEOUT_MS = prev;
      }
    });
  });
});

process.on('exit', () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
