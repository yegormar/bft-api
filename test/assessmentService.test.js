'use strict';

// Use a dedicated test port so tests do not conflict with a running dev server (e.g. PORT=3000).
process.env.PORT = process.env.PORT || '39391';
// Set env before any app module is loaded so config and background pregen behave correctly.
const path = require('path');
const os = require('os');
const fs = require('fs');
const tmpDir = path.join(os.tmpdir(), `bft-assessment-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.BFT_QUESTIONS_STORE_DIR = tmpDir;
process.env.BFT_PREGEN_QUEUE_CAP = '3';
process.env.BFT_PREGEN_REFILL_THRESHOLD = '1';
process.env.MIN_SIGNAL_PER_DIMENSION = '1';
process.env.BFT_SKIP_BACKGROUND_PREGEN = '1';
process.env.BFT_QUESTION_LLM_TIMEOUT_MS = '5000';
process.env.BFT_SCENARIO_STORE_FIRST = 'false';
process.env.BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE = 'conf/scenario_step1.txt';
process.env.BFT_SCENARIO_STEP3_INSTRUCTIONS_FILE = 'conf/scenario_step3.txt';
process.env.LLM_NUM_CTX = '32768';
process.env.LLM_THINK = 'false';
process.env.LLM_CHECKUP_INTERVAL_SEC = '180';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const assessmentService = require('../src/services/assessmentService');
const sessionService = require('../src/services/sessionService');
const questionStore = require('../src/services/questionStore');

describe('assessmentService', () => {
  describe('getNextQuestion', () => {
    it('returns completed when interview is complete (MAX_INTERVIEW_QUESTIONS=0)', async () => {
      const prevMax = process.env.MAX_INTERVIEW_QUESTIONS;
      const prevDev = process.env.BFT_DEV_MAX_QUESTIONS;
      process.env.MAX_INTERVIEW_QUESTIONS = '0';
      delete process.env.BFT_DEV_MAX_QUESTIONS;
      try {
        const session = sessionService.create(null);
        const result = await assessmentService.getNextQuestion(session.id, 'user-complete-' + Date.now());
        assert.strictEqual(result.completed, true);
        assert.strictEqual(result.nextQuestion, null);
        assert.ok(result.progress);
        assert.strictEqual(result.progress.percentComplete, 100);
      } finally {
        if (prevMax !== undefined) process.env.MAX_INTERVIEW_QUESTIONS = prevMax;
        else delete process.env.MAX_INTERVIEW_QUESTIONS;
        if (prevDev !== undefined) process.env.BFT_DEV_MAX_QUESTIONS = prevDev;
      }
    });

    it('returns question from store or LLM when queue is empty (store when LLM fails, LLM when LLM succeeds)', async () => {
      const profile = { dominant: ['creative'], secondaryTone: 'adventurous' };
      const session = sessionService.create(profile);
      const bftUserId = 'user-store-' + Date.now();
      const storeDir = process.env.BFT_QUESTIONS_STORE_DIR;
      assert.ok(storeDir);

      const question = {
        title: 'Stored test question?',
        type: 'single_choice',
        options: [{ text: 'Yes', value: 'y' }, { text: 'No', value: 'n' }],
      };
      const dimensionSet = [
        { dimensionType: 'aptitude', dimensionId: 'logical_analytical_reasoning' },
      ];
      const profileKey = questionStore.getProfileKey(profile);
      questionStore.save(storeDir, profileKey, question, dimensionSet, 'Test summary');

      const result = await assessmentService.getNextQuestion(session.id, bftUserId);

      assert.strictEqual(result.completed, false);
      assert.ok(result.nextQuestion);
      assert.ok(result.nextQuestion.id && result.nextQuestion.id.startsWith('scenario_'));
      if (result.nextQuestion.title === question.title) {
        assert.strictEqual(result.assessmentSummary, 'Test summary');
        const contentHash = questionStore.computeContentHash(question);
        const used = questionStore.getUsedSet(storeDir, bftUserId);
        assert.ok(used.has(contentHash), 'question should be marked as used for this user');
      }
    });

    it('marks stored question as used when served from store (or gets LLM question when LLM succeeds)', async () => {
      const profile = { dominant: ['reuse-test'] };
      const session = sessionService.create(profile);
      const bftUserId = 'user-reuse-' + Date.now();
      const storeDir = process.env.BFT_QUESTIONS_STORE_DIR;

      const question = {
        title: 'One-time question?',
        type: 'single_choice',
        options: [{ text: 'A', value: 'a' }],
      };
      const dimensionSet = [{ dimensionType: 'trait', dimensionId: 'adaptability' }];
      const profileKey = questionStore.getProfileKey(profile);
      questionStore.save(storeDir, profileKey, question, dimensionSet, null);

      const result = await assessmentService.getNextQuestion(session.id, bftUserId);
      assert.strictEqual(result.completed, false);
      assert.ok(result.nextQuestion && result.nextQuestion.title);

      if (result.nextQuestion.title === question.title) {
        const contentHash = questionStore.computeContentHash(question);
        const used = questionStore.getUsedSet(storeDir, bftUserId);
        assert.ok(used.has(contentHash), 'question must be in used set so same user would not get it again');
        const candidates = questionStore.listByProfile(storeDir, profileKey).filter((item) => !used.has(item.contentHash));
        assert.strictEqual(candidates.length, 0, 'no unused candidates for this user after serving');
      }
    });

    it('returns serviceUnavailable when component returns null, or next question when LLM succeeds', async () => {
      const profile = { dominant: ['service-unavailable-test-' + Date.now()] };
      const session = sessionService.create(profile);
      const bftUserId = 'user-service-unavailable-' + Date.now();
      const result = await assessmentService.getNextQuestion(session.id, bftUserId);
      assert.strictEqual(result.completed, false);
      if (result.serviceUnavailable) {
        assert.strictEqual(result.nextQuestion, undefined);
        assert.ok(result.message && result.message.length > 0);
        assert.ok(result.progress);
        assert.strictEqual(typeof result.retryAfterSeconds, 'number');
      } else {
        assert.ok(result.nextQuestion && result.nextQuestion.title);
      }
    });

    it('progress reports totalDimensions from model (all dimensions) and percentComplete from coverage', async () => {
      const prevMax = process.env.MAX_INTERVIEW_QUESTIONS;
      const prevDev = process.env.BFT_DEV_MAX_QUESTIONS;
      process.env.MAX_INTERVIEW_QUESTIONS = '20';
      delete process.env.BFT_DEV_MAX_QUESTIONS;
      try {
        const session = sessionService.create(null);
        const result = await assessmentService.getNextQuestion(session.id, 'user-progress-' + Date.now());
        assert.ok(result.progress, 'progress should be returned');
        assert.strictEqual(typeof result.progress.totalDimensions, 'number');
        assert.ok(result.progress.totalDimensions >= 1, 'totalDimensions is dimension count from model');
        assert.ok(result.progress.percentComplete >= 0 && result.progress.percentComplete <= 100);
        if (result.serviceUnavailable) {
          assert.strictEqual(result.progress.questionsAsked, 0, 'when service unavailable, no question was served');
        } else {
          assert.strictEqual(result.progress.questionsAsked, 1);
        }
      } finally {
        if (prevMax !== undefined) process.env.MAX_INTERVIEW_QUESTIONS = prevMax;
        else delete process.env.MAX_INTERVIEW_QUESTIONS;
        if (prevDev !== undefined) process.env.BFT_DEV_MAX_QUESTIONS = prevDev;
      }
    });
  });

  describe('getSessionHealth', () => {
    it('returns null for unknown session', () => {
      const health = assessmentService.getSessionHealth('nonexistent-session-id');
      assert.strictEqual(health, null);
    });

    it('returns health with preGeneratedQuestions, measuredDimensions, interviewComplete, backgroundPregenRunning', () => {
      const session = sessionService.create(null);
      const health = assessmentService.getSessionHealth(session.id);
      assert.ok(health);
      assert.strictEqual(health.sessionId, session.id);
      assert.strictEqual(typeof health.preGeneratedQuestions, 'number');
      assert.strictEqual(typeof health.questionsAsked, 'number');
      assert.strictEqual(typeof health.answersCount, 'number');
      assert.ok(health.measuredDimensions && typeof health.measuredDimensions === 'object');
      assert.strictEqual(typeof health.measuredDimensions.covered, 'number');
      assert.strictEqual(typeof health.measuredDimensions.total, 'number');
      assert.strictEqual(typeof health.measuredDimensions.percentComplete, 'number');
      assert.ok(health.measuredDimensions.byType && typeof health.measuredDimensions.byType === 'object');
      assert.strictEqual(typeof health.interviewComplete, 'boolean');
      assert.strictEqual(typeof health.backgroundPregenRunning, 'boolean');
      assert.strictEqual(health.questionsAsked, 0);
      assert.strictEqual(health.answersCount, 0);
    });

    it('reflects questions asked and measured dimensions after getNextQuestion', async () => {
      const profile = { dominant: ['test'] };
      const session = sessionService.create(profile);
      const storeDir = process.env.BFT_QUESTIONS_STORE_DIR;
      const profileKey = questionStore.getProfileKey(profile);
      questionStore.save(storeDir, profileKey, { title: 'Q?', type: 'single_choice', options: [{ text: 'A', value: 'a' }] }, [{ dimensionType: 'aptitude', dimensionId: 'logical_analytical_reasoning' }], null);
      await assessmentService.getNextQuestion(session.id, 'user-health-' + Date.now());
      const health = assessmentService.getSessionHealth(session.id);
      assert.ok(health);
      assert.strictEqual(health.questionsAsked, 1);
      assert.ok(health.measuredDimensions.covered >= 0);
      assert.ok(health.measuredDimensions.byType.aptitudes.total >= 0);
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
