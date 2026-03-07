'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('node:child_process');
const tmpDir = path.join(os.tmpdir(), `bft-qgen-index-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.BFT_QUESTION_LLM_TIMEOUT_MS = '5000';
process.env.BFT_SCENARIO_STORE_FIRST = 'false';
process.env.BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE = 'conf/scenario_step1.txt';
process.env.BFT_SCENARIO_STEP3_INSTRUCTIONS_FILE = 'conf/scenario_step3.txt';

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
        assert.deepStrictEqual(result.dimensionSet, [
          { dimensionType: 'aptitude', dimensionId: 'logical_analytical_reasoning', id: 'logical_analytical_reasoning' },
        ]);
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
      if (!result || !result.question) {
        assert.ok(!result || (result.question === null && typeof result.reason === 'string'), 'when no question, expect null or { question: null, reason }');
      } else {
        assert.strictEqual(result.source, 'llm');
        assert.ok(result.question && result.question.title);
      }
    });
  });

  describe('getQuestionGenConfig', () => {
    it('process exits when BFT_QUESTION_LLM_TIMEOUT_MS is unset (used by component on first request)', () => {
      const env = { ...process.env };
      delete env.BFT_QUESTION_LLM_TIMEOUT_MS;
      const child = spawnSync(
        process.execPath,
        ['-e', "require('./config/questionGeneration').getQuestionGenConfig()"],
        { cwd: path.resolve(__dirname, '../..'), env, encoding: 'utf8' }
      );
      assert.strictEqual(child.status, 1);
      assert.match(child.stderr || '', /BFT_QUESTION_LLM_TIMEOUT_MS is required/);
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
