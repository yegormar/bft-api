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
 * Triangle measurement tests (triangle mode).
 * - Vertex order a,b,c maps to dims[0], dims[1], dims[2]
 * - Dimension scores from Bayesian latent-trait scorer (zone-aware Dirichlet + rejection), range [1, 5]
 * - Barycentric normalized and clamped; invalid -> (1/3, 1/3, 1/3)
 * - Joint inference across all triangles (no simple average; scores from posterior)
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

  describe('triangle score and vertex mapping (Bayesian scorer)', () => {
    it('ball at vertex A gives A highest score (1-5), B and C low', async () => {
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
      assert.ok(helping.mean >= 4 && helping.mean <= 5, 'vertex A (a=1) -> high score');
      assert.ok(mastery.mean >= 1 && mastery.mean <= 2, 'vertex B (b=0) -> low score');
      assert.ok(recognition.mean >= 1 && recognition.mean <= 2, 'vertex C (c=0) -> low score');
    });

    it('ball at vertex B gives B highest score, A and C low', async () => {
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
      assert.ok(helping.mean >= 1 && helping.mean <= 2);
      assert.ok(mastery.mean >= 4 && mastery.mean <= 5);
      assert.ok(recognition.mean >= 1 && recognition.mean <= 2);
    });

    it('centre (1/3, 1/3, 1/3) gives all three dimensions scores in [1,5]', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      const third = 1 / 3;
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: third, b: third, c: third } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const ids = ['value_helping_others_impact', 'value_mastery_growth', 'value_recognition_visibility'];
      const centreScores = values.filter((d) => ids.includes(d.id)).map((d) => d.mean);
      assert.strictEqual(centreScores.length, 3, 'all three dimensions from triangle present');
      centreScores.forEach((m) => assert.ok(m >= 1 && m <= 5, 'score in [1,5]'));
    });

    it('arbitrary barycentric (0.5, 0.3, 0.2) gives A highest, then B, then C', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 0.5, b: 0.3, c: 0.2 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      const mastery = values.find((d) => d.id === 'value_mastery_growth');
      const recognition = values.find((d) => d.id === 'value_recognition_visibility');
      assert.ok(helping.mean >= mastery.mean && mastery.mean >= recognition.mean, 'order A >= B >= C');
      assert.ok(helping.mean >= 1 && helping.mean <= 5);
      assert.ok(recognition.mean >= 1 && recognition.mean <= 5);
    });
  });

  describe('normalization and fallback', () => {
    it('value that sums to 2 is renormalized; C gets highest score (0.5 after norm)', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 0.5, b: 0.5, c: 1 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const recognition = values.find((d) => d.id === 'value_recognition_visibility');
      assert.ok(recognition);
      assert.ok(recognition.mean >= 2 && recognition.mean <= 5, 'C dominant after renormalize');
    });

    it('missing or invalid value falls back to (1/3, 1/3, 1/3); all three present with mid-range', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: null }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      assert.ok(helping);
      assert.ok(helping.mean >= 1 && helping.mean <= 5);
    });
  });

  describe('aggregation across triangles (Bayesian joint inference)', () => {
    it('dimension measured in two triangles appears with scores in [1,5]', async () => {
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
      assert.ok(belonging.mean >= 4 && belonging.mean <= 5, 'c=1 -> high score');
      const financial = values.find((d) => d.id === 'value_financial_success');
      assert.ok(financial, 'triangle_02 vertex a = financial');
      assert.ok(financial.mean >= 1 && financial.mean <= 2, 'scenario_1 we sent a=0 so financial low');
    });

    it('same dimension in multiple triangles: joint inference produces score in [1,5]', async () => {
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
      assert.ok(mastery.count >= 2, 'mastery appears in multiple triangles');
      assert.ok(mastery.mean >= 1 && mastery.mean <= 5, 'Bayesian score in range');
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

  describe('integration edge cases (collectTriangleRawResponses, buildDimensionScoresForAssessment)', () => {
    it('triangle mode with zero answers uses aggregate path and returns dimensionScores structure', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      const assessment = assessmentService.getAssessment(session.id);
      assert.ok(assessment.dimensionScores);
      assert.ok(Array.isArray(assessment.dimensionScores.traits));
      assert.ok(Array.isArray(assessment.dimensionScores.values));
      assert.ok(Array.isArray(assessment.dimensionScores.aptitudes));
    });

    it('answer with questionId not in servedQuestions is skipped; aggregate path used', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_99', value: { a: 1, b: 0, c: 0 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      assert.ok(assessment.dimensionScores);
      const values = assessment.dimensionScores.values || [];
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      assert.ok(!helping || helping.mean < 4, 'scenario_99 not served so triangle not used; no strong A score');
    });

    it('answers in non-sequential order are both collected and used by Bayesian scorer', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [
          { questionId: 'scenario_1', value: { a: 0, b: 0, c: 1 } },
          { questionId: 'scenario_0', value: { a: 1, b: 0, c: 0 } },
        ],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      const belonging = values.find((d) => d.id === 'value_belonging_community');
      assert.ok(helping && helping.mean >= 4, 'scenario_0 (A=1) applied despite answer order');
      assert.ok(belonging && belonging.mean >= 4, 'scenario_1 (C=1) applied despite answer order');
    });

    it('dimension type mapping: value in values, aptitude in aptitudes', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 1, b: 0, c: 0 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const traits = assessment.dimensionScores.traits || [];
      const aptitudes = assessment.dimensionScores.aptitudes || [];
      assert.ok(values.some((d) => d.id === 'value_helping_others_impact'), 'value dimension in values');
      assert.ok(values.every((d) => (d.id || '').startsWith('value_')), 'values only contain value_ ids');
      assert.ok(aptitudes.every((d) => (d.id || '').startsWith('aptitude_')), 'aptitudes only contain aptitude_ ids');
      assert.ok(traits.length >= 0 && traits.every((d) => (d.id || '').startsWith('trait_')), 'traits only contain trait_ ids');
    });
  });

  describe('combined triangles (values/traits + aptitudes)', () => {
    it('loads 19 triangles total (11 from dimension_triangles + 8 from dimension_triangles_aptitudes)', async () => {
      const session = sessionService.create(null);
      const result = await assessmentService.getNextQuestion(session.id, '');
      assert.strictEqual(result.completed, false);
      assert.strictEqual(result.progress.totalDimensions, 19, 'combined set has 19 triangles');
    });

    it('aptitude triangle scores appear in dimensionScores.aptitudes', async () => {
      const session = sessionService.create(null);
      for (let i = 0; i < 12; i++) {
        await assessmentService.getNextQuestion(session.id, '');
      }
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_11', value: { a: 1, b: 0, c: 0 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const aptitudes = assessment.dimensionScores.aptitudes || [];
      assert.ok(Array.isArray(aptitudes));
      const logical = aptitudes.find((d) => d.id === 'aptitude_logical_analytical_reasoning');
      assert.ok(logical, 'aptitude_logical_analytical_reasoning should be in aptitudes after answering an aptitude triangle');
      assert.ok(logical.mean >= 4 && logical.mean <= 5, 'ball at vertex A gives that dimension high score');
      assert.strictEqual(logical.band, 'high');
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
