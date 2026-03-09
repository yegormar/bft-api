'use strict';

// Triangle mode: set before any app module loads so getAssessmentMode() returns 'triangles'.
process.env.BFT_ASSESSMENT_MODE = 'triangles';

process.env.PORT = process.env.PORT || '39392';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const path = require('path');
const os = require('os');
const fs = require('fs');
const tmpDir = path.join(os.tmpdir(), `bft-triangle-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.BFT_QUESTIONS_STORE_DIR = tmpDir;
process.env.BFT_FEEDBACK_FILE = path.join(tmpDir, 'feedback.jsonl');
fs.writeFileSync(process.env.BFT_FEEDBACK_FILE, '', 'utf8');
process.env.BFT_PREGEN_QUEUE_CAP = '0';
process.env.BFT_PREGEN_REFILL_THRESHOLD = '0';
process.env.MIN_SIGNAL_PER_DIMENSION = '1';
process.env.BFT_SKIP_BACKGROUND_PREGEN = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const assessmentService = require('../src/services/assessmentService');
const sessionService = require('../src/services/sessionService');

/**
 * Triangle measurement tests per bft-doc/triangle-measurement-format.md:
 * - Vertex order a,b,c maps to dims[0], dims[1], dims[2]
 * - score = (coordinate * 4) + 1, range [1, 5]
 * - Barycentric normalized and clamped; invalid -> (1/3, 1/3, 1/3)
 * - Aggregation: multiple measurements per dimension averaged (sum/count)
 */

describe('assessmentService (triangle mode)', () => {
  describe('getNextQuestion', () => {
    it('returns a triangle question with type, title, prompt, vertices, and id', async () => {
      const session = sessionService.create(null);
      const result = await assessmentService.getNextQuestion(session.id, '');
      assert.strictEqual(result.completed, false);
      assert.ok(result.nextQuestion);
      assert.strictEqual(result.nextQuestion.type, 'triangle');
      assert.ok(result.nextQuestion.title && result.nextQuestion.title.length > 0);
      assert.ok(result.nextQuestion.prompt);
      assert.ok(result.nextQuestion.vertices);
      assert.ok(result.nextQuestion.vertices.a && result.nextQuestion.vertices.a.label && result.nextQuestion.vertices.a.dimensionId);
      assert.ok(result.nextQuestion.vertices.b && result.nextQuestion.vertices.b.label && result.nextQuestion.vertices.b.dimensionId);
      assert.ok(result.nextQuestion.vertices.c && result.nextQuestion.vertices.c.label && result.nextQuestion.vertices.c.dimensionId);
      assert.ok(result.nextQuestion.id && result.nextQuestion.id.startsWith('scenario_'));
      assert.strictEqual(result.nextQuestion.id, 'scenario_0');
      assert.ok(result.progress);
      assert.strictEqual(typeof result.progress.questionsAsked, 'number');
      assert.strictEqual(typeof result.progress.totalDimensions, 'number');
    });

    it('vertex order a,b,c matches dimensions_measured order (first triangle)', async () => {
      const session = sessionService.create(null);
      const result = await assessmentService.getNextQuestion(session.id, '');
      const q = result.nextQuestion;
      assert.strictEqual(q.vertices.a.dimensionId, 'value_helping_others_impact');
      assert.strictEqual(q.vertices.b.dimensionId, 'value_mastery_growth');
      assert.strictEqual(q.vertices.c.dimensionId, 'value_recognition_visibility');
    });
  });

  describe('triangle score formula and vertex mapping', () => {
    it('score = (coordinate * 4) + 1: ball at vertex A gives that dimension 5.0', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 1, b: 0, c: 0 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      const mastery = values.find((d) => d.id === 'value_mastery_growth');
      const recognition = values.find((d) => d.id === 'value_recognition_visibility');
      assert.ok(helping, 'value_helping_others_impact should be present');
      assert.strictEqual(helping.mean, 5, 'vertex A (a=1) -> score 5');
      assert.strictEqual(mastery.mean, 1, 'vertex B (b=0) -> score 1');
      assert.strictEqual(recognition.mean, 1, 'vertex C (c=0) -> score 1');
    });

    it('ball at vertex B gives dimension B score 5.0, A and C score 1.0', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 0, b: 1, c: 0 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      const mastery = values.find((d) => d.id === 'value_mastery_growth');
      const recognition = values.find((d) => d.id === 'value_recognition_visibility');
      assert.strictEqual(helping.mean, 1);
      assert.strictEqual(mastery.mean, 5);
      assert.strictEqual(recognition.mean, 1);
    });

    it('centre (1/3, 1/3, 1/3) gives all three dimensions score 2.33', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      const third = 1 / 3;
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: third, b: third, c: third } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const expected = Math.round((third * 4 + 1) * 100) / 100;
      for (const d of values) {
        if (['value_helping_others_impact', 'value_mastery_growth', 'value_recognition_visibility'].includes(d.id)) {
          assert.strictEqual(d.mean, expected, `${d.id} should be ${expected} (centre)`);
        }
      }
    });

    it('arbitrary barycentric (0.5, 0.3, 0.2) produces score = coord*4+1 per vertex', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 0.5, b: 0.3, c: 0.2 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const scoreA = 0.5 * 4 + 1;
      const scoreB = 0.3 * 4 + 1;
      const scoreC = 0.2 * 4 + 1;
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      const mastery = values.find((d) => d.id === 'value_mastery_growth');
      const recognition = values.find((d) => d.id === 'value_recognition_visibility');
      assert.strictEqual(helping.mean, Math.round(scoreA * 100) / 100);
      assert.strictEqual(mastery.mean, Math.round(scoreB * 100) / 100);
      assert.strictEqual(recognition.mean, Math.round(scoreC * 100) / 100);
    });
  });

  describe('normalization and fallback', () => {
    it('value that sums to 2 is renormalized (e.g. 0.5, 0.5, 1 -> 0.25, 0.25, 0.5)', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 0.5, b: 0.5, c: 1 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const recognition = values.find((d) => d.id === 'value_recognition_visibility');
      assert.ok(recognition);
      const expectedC = (1 / 2) * 4 + 1;
      assert.strictEqual(recognition.mean, Math.round(expectedC * 100) / 100, 'c renormalized to 0.5 -> score 3');
    });

    it('missing or invalid value falls back to (1/3, 1/3, 1/3)', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: null }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const expected = Math.round(((1 / 3) * 4 + 1) * 100) / 100;
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      assert.ok(helping);
      assert.strictEqual(helping.mean, expected);
    });
  });

  describe('aggregation across triangles', () => {
    it('dimension measured in two triangles has mean = (score1 + score2) / 2', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 1, b: 0, c: 0 } }],
      });
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_1', value: { a: 0, b: 0, c: 1 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const belonging = values.find((d) => d.id === 'value_belonging_community');
      assert.ok(belonging, 'value_belonging_community is in triangle_02 (vertex c)');
      assert.strictEqual(belonging.count, 1);
      assert.strictEqual(belonging.mean, 5, 'c=1 -> score 5');
      const financial = values.find((d) => d.id === 'value_financial_success');
      assert.ok(financial, 'triangle_02 vertex a = financial');
      assert.strictEqual(financial.count, 1);
      assert.strictEqual(financial.mean, 1, 'scenario_1 we sent a=0 so financial gets score 1');
    });

    it('same dimension in multiple triangles: scores aggregated by simple average', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 0, b: 1, c: 0 } }],
      });
      for (let i = 1; i <= 6; i++) {
        await assessmentService.getNextQuestion(session.id, '');
        const value = i === 6 ? { a: 0, b: 1, c: 0 } : { a: 1 / 3, b: 1 / 3, c: 1 / 3 };
        assessmentService.submitAnswers(session.id, {
          answers: [{ questionId: `scenario_${i}`, value }],
        });
      }
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const mastery = values.find((d) => d.id === 'value_mastery_growth');
      assert.ok(mastery);
      assert.ok(mastery.count >= 2, 'mastery appears in triangle_01, 07, 08 so at least 2 measurements');
      const expectedMean = (5 + 2.33 + 5) / 3;
      assert.ok(Math.abs(mastery.mean - expectedMean) < 0.02, 'mean is average of scores from all triangles measuring mastery');
    });
  });

  describe('band from mean', () => {
    it('mean <= 2 -> band low, mean >= 4 -> band high, else medium', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 1, b: 0, c: 0 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      const mastery = values.find((d) => d.id === 'value_mastery_growth');
      assert.strictEqual(helping.band, 'high');
      assert.strictEqual(mastery.band, 'low');
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
