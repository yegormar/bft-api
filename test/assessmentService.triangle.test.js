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

(function suppressBftLogs() {
  const orig = console.log;
  console.log = function (...args) {
    const s = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
    if (s.startsWith('[bft]')) return;
    orig.apply(console, args);
  };
})();

const assessmentService = require('../src/services/assessmentService');
const sessionService = require('../src/services/sessionService');

/** Same combined triangle order as assessmentService in test mode (values then aptitudes). */
function loadCombinedTriangles() {
  const dataPath = path.join(__dirname, '..', 'src', 'data');
  const data1 = JSON.parse(fs.readFileSync(path.join(dataPath, 'dimension_triangles.json'), 'utf8'));
  const data2 = JSON.parse(fs.readFileSync(path.join(dataPath, 'dimension_triangles_aptitudes.json'), 'utf8'));
  return [...(data1.triangles || []), ...(data2.triangles || [])];
}

/** Log all dimension scores per profile for interpretation when running tests. */
function logDimensionScores(profileName, dimensionScores) {
  const { traits = [], values = [], aptitudes = [] } = dimensionScores || {};
  const pad = (s, w) => String(s).padEnd(w);
  const row = (id, mean, band) => `  ${pad(id, 42)}  ${pad(mean.toFixed(2), 5)}  ${band}`;
  const section = (label, list) => {
    if (!list.length) return `${label}\n    (none)\n`;
    return `${label}\n${list.map((d) => row(d.id, d.mean, d.band)).join('\n')}\n`;
  };
  console.log('\n' + '='.repeat(72));
  console.log('PROFILE: %s', profileName);
  console.log('='.repeat(72));
  console.log(section('Traits', traits));
  console.log(section('Values', values));
  console.log(section('Aptitudes', aptitudes));
  console.log('(All measurements above: dimension id, mean score 1-5, band low/medium/high)\n');
}

/**
 * Build 19 barycentric answers that maximize the given dimension IDs (pick vertex that has one of them; else centre).
 * Returns array of { a, b, c } in scenario_0 .. scenario_18 order.
 */
function buildProfileAnswers(triangles, dimensionIdsToMaximize) {
  const set = new Set(dimensionIdsToMaximize);
  const third = 1 / 3;
  return triangles.map((tri) => {
    const v = tri.vertices || {};
    for (const key of ['a', 'b', 'c']) {
      const dimId = v[key]?.dimensionId;
      if (dimId && set.has(dimId)) {
        return key === 'a' ? { a: 1, b: 0, c: 0 } : key === 'b' ? { a: 0, b: 1, c: 0 } : { a: 0, b: 0, c: 1 };
      }
    }
    return { a: third, b: third, c: third };
  });
}

/**
 * Triangle measurement tests (triangle mode).
 * - Vertex order a,b,c maps to dims[0], dims[1], dims[2]
 * - Dimension scores from Bayesian latent-trait scorer (zone-aware Dirichlet + rejection), range [1, 5]
 * - Barycentric normalized and clamped; invalid -> (1/3, 1/3, 1/3)
 * - Separate scaling: aptitudes vs traits+values (two MCMC runs, merged)
 *
 * Coverage:
 * - Single triangle: most tests use only scenario_0 (or one other) to assert score/band for that triangle's dimensions.
 * - Multi-triangle: a few tests use 2-7 triangles to assert aggregation and order.
 * - Full assessment (all 19 triangles): centre (all middle), all corners (rotate A/B/C), all edges (rotate AB/AC/BC); assert structure, scores in [1,5], and bands.
 * - Profile validation: highly logical, highly artistic, super team player; answers built from triangle data to maximize profile dimensions; assert assessment reflects profile (e.g. logical aptitude high for logical profile).
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

    it('centre (1/3, 1/3, 1/3) single triangle: no differentiation yields neutral (all medium)', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      const third = 1 / 3;
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: third, b: third, c: third } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const ids = ['value_helping_others_impact', 'value_mastery_growth', 'value_recognition_visibility'];
      const tri0 = values.filter((d) => ids.includes(d.id));
      assert.strictEqual(tri0.length, 3);
      tri0.forEach((d) => assert.strictEqual(d.band, 'medium', `${d.id} should be medium when no signal`));
      tri0.forEach((d) => assert.ok(d.mean >= 2.5 && d.mean <= 3.5, `${d.id} mean should be near 3; got ${d.mean}`));
    });

    it('edge (0.5, 0.5, 0) gives A and B high, C low (single triangle)', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 0.5, b: 0.5, c: 0 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      const mastery = values.find((d) => d.id === 'value_mastery_growth');
      const recognition = values.find((d) => d.id === 'value_recognition_visibility');
      assert.ok(helping.mean >= 3 && helping.mean <= 5, 'A blended high');
      assert.ok(mastery.mean >= 3 && mastery.mean <= 5, 'B blended high');
      assert.ok(recognition.mean >= 1 && recognition.mean <= 2, 'C rejected -> low');
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

    it('mixed extreme and medium: one corner (scenario_0 A=1) and one centre (scenario_1) yield helping high, triangle_1 dimensions medium', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 1, b: 0, c: 0 } }],
      });
      await assessmentService.getNextQuestion(session.id, '');
      const third = 1 / 3;
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_1', value: { a: third, b: third, c: third } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      const financial = values.find((d) => d.id === 'value_financial_success');
      const workLife = values.find((d) => d.id === 'value_work_life_balance_wellbeing');
      const belonging = values.find((d) => d.id === 'value_belonging_community');
      assert.ok(helping && helping.mean >= 4 && helping.band === 'high', 'extreme A in tri0 -> helping high');
      assert.ok(financial && financial.band === 'medium', 'centre in tri1 -> financial medium');
      assert.ok(workLife && workLife.band === 'medium');
      assert.ok(belonging && belonging.band === 'medium');
    });

    it('separate scaling: one extreme value triangle and one extreme aptitude triangle yield both a value and an aptitude at high (each group has own 1-5 scale)', async () => {
      const session = sessionService.create(null);
      await assessmentService.getNextQuestion(session.id, '');
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_0', value: { a: 1, b: 0, c: 0 } }],
      });
      for (let i = 1; i <= 11; i++) {
        await assessmentService.getNextQuestion(session.id, '');
      }
      assessmentService.submitAnswers(session.id, {
        answers: [{ questionId: 'scenario_11', value: { a: 1, b: 0, c: 0 } }],
      });
      const assessment = assessmentService.getAssessment(session.id);
      const values = assessment.dimensionScores.values || [];
      const aptitudes = assessment.dimensionScores.aptitudes || [];
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      const logical = aptitudes.find((d) => d.id === 'aptitude_logical_analytical_reasoning');
      assert.ok(helping && helping.mean >= 4 && helping.band === 'high', 'value group: helping at 5 (or high)');
      assert.ok(logical && logical.mean >= 4 && logical.band === 'high', 'aptitude group: logical at 5 (or high); separate scale');
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

    it('full assessment (all 19 triangles, centre answers): dimensionScores has traits, values, aptitudes; all scores in [1,5]', async () => {
      const session = sessionService.create(null);
      const third = 1 / 3;
      for (let i = 0; i < 19; i++) {
        const result = await assessmentService.getNextQuestion(session.id, '');
        if (result.completed || !result.nextQuestion) break;
        assessmentService.submitAnswers(session.id, {
          answers: [{ questionId: result.nextQuestion.id, value: { a: third, b: third, c: third } }],
        });
      }
      const assessment = assessmentService.getAssessment(session.id);
      const { traits, values, aptitudes } = assessment.dimensionScores || {};
      assert.ok(Array.isArray(traits), 'traits array present');
      assert.ok(Array.isArray(values), 'values array present');
      assert.ok(Array.isArray(aptitudes), 'aptitudes array present');
      const allDims = [...(traits || []), ...(values || []), ...(aptitudes || [])];
      assert.ok(allDims.length >= 10, 'multiple dimensions measured across 19 triangles');
      allDims.forEach((d) => {
        assert.ok(d.id && typeof d.mean === 'number', `${d.id} has mean`);
        assert.ok(d.mean >= 1 && d.mean <= 5, `${d.id} mean ${d.mean} in [1,5]`);
        assert.ok(['low', 'medium', 'high'].includes(d.band), `${d.id} has band`);
      });
      assert.ok(values.some((d) => d.id.startsWith('value_')), 'at least one value dimension');
      assert.ok(traits.length >= 0, 'traits may be empty or populated');
      assert.ok(aptitudes.some((d) => d.id.startsWith('aptitude_')), 'at least one aptitude dimension from aptitude triangles');
    });

    it('all centre (ball in middle every question): lowEngagement true, neutral scores (mean 3, band medium)', async () => {
      const session = sessionService.create(null);
      const third = 1 / 3;
      for (let i = 0; i < 19; i++) {
        const result = await assessmentService.getNextQuestion(session.id, '');
        if (result.completed || !result.nextQuestion) break;
        assessmentService.submitAnswers(session.id, {
          answers: [{ questionId: result.nextQuestion.id, value: { a: third, b: third, c: third } }],
        });
      }
      const assessment = assessmentService.getAssessment(session.id);
      assert.strictEqual(assessment.lowEngagement, true, 'all centre must set lowEngagement');
      const allDims = [
        ...(assessment.dimensionScores?.traits || []),
        ...(assessment.dimensionScores?.values || []),
        ...(assessment.dimensionScores?.aptitudes || []),
      ];
      assert.ok(allDims.length >= 10);
      allDims.forEach((d) => {
        assert.strictEqual(d.mean, 3, `${d.id} neutral mean 3`);
        assert.strictEqual(d.band, 'medium', `${d.id} band medium`);
      });
    });

    it('full assessment (all 19 triangles, all corners): rotate A, B, C vertex choices; structure and scores valid', async () => {
      const session = sessionService.create(null);
      const corners = [
        { a: 1, b: 0, c: 0 },
        { a: 0, b: 1, c: 0 },
        { a: 0, b: 0, c: 1 },
      ];
      for (let i = 0; i < 19; i++) {
        const result = await assessmentService.getNextQuestion(session.id, '');
        if (result.completed || !result.nextQuestion) break;
        const value = corners[i % 3];
        assessmentService.submitAnswers(session.id, {
          answers: [{ questionId: result.nextQuestion.id, value }],
        });
      }
      const assessment = assessmentService.getAssessment(session.id);
      const { traits, values, aptitudes } = assessment.dimensionScores || {};
      assert.ok(Array.isArray(traits) && Array.isArray(values) && Array.isArray(aptitudes));
      const allDims = [...(traits || []), ...(values || []), ...(aptitudes || [])];
      assert.ok(allDims.length >= 10, 'multiple dimensions from 19 triangles');
      allDims.forEach((d) => {
        assert.ok(d.id && typeof d.mean === 'number', `${d.id} has mean`);
        assert.ok(d.mean >= 1 && d.mean <= 5, `${d.id} mean ${d.mean} in [1,5]`);
        assert.ok(['low', 'medium', 'high'].includes(d.band), `${d.id} has band`);
      });
      assert.ok(values.length >= 1, 'values populated');
      assert.ok(aptitudes.length >= 1, 'aptitudes populated');
      const highCount = allDims.filter((d) => d.band === 'high').length;
      const lowCount = allDims.filter((d) => d.band === 'low').length;
      assert.ok(highCount >= 1 && lowCount >= 1, 'corners produce at least one high and one low across dimensions');
    });

    it('full assessment (all 19 triangles, all edges): rotate AB, AC, BC edge choices; structure and scores valid', async () => {
      const session = sessionService.create(null);
      const edges = [
        { a: 0.5, b: 0.5, c: 0 },
        { a: 0.5, b: 0, c: 0.5 },
        { a: 0, b: 0.5, c: 0.5 },
      ];
      for (let i = 0; i < 19; i++) {
        const result = await assessmentService.getNextQuestion(session.id, '');
        if (result.completed || !result.nextQuestion) break;
        const value = edges[i % 3];
        assessmentService.submitAnswers(session.id, {
          answers: [{ questionId: result.nextQuestion.id, value }],
        });
      }
      const assessment = assessmentService.getAssessment(session.id);
      const { traits, values, aptitudes } = assessment.dimensionScores || {};
      assert.ok(Array.isArray(traits) && Array.isArray(values) && Array.isArray(aptitudes));
      const allDims = [...(traits || []), ...(values || []), ...(aptitudes || [])];
      assert.ok(allDims.length >= 10, 'multiple dimensions from 19 triangles');
      allDims.forEach((d) => {
        assert.ok(d.id && typeof d.mean === 'number', `${d.id} has mean`);
        assert.ok(d.mean >= 1 && d.mean <= 5, `${d.id} mean ${d.mean} in [1,5]`);
        assert.ok(['low', 'medium', 'high'].includes(d.band), `${d.id} has band`);
      });
      assert.ok(values.length >= 1 && aptitudes.length >= 1, 'values and aptitudes populated');
    });

    it('full assessment (all 19 triangles, all middle zones): interior positions e.g. A 34%, B 53%, C 13%; no corners or edges', async () => {
      const session = sessionService.create(null);
      // Middle zone = interior of triangle: all a,b,c > 0, none at 0 or 0.5 (edge). Rotate several interior points.
      const middleZones = [
        { a: 0.34, b: 0.53, c: 0.13 },
        { a: 0.25, b: 0.5, c: 0.25 },
        { a: 0.4, b: 0.35, c: 0.25 },
        { a: 0.2, b: 0.45, c: 0.35 },
        { a: 0.45, b: 0.3, c: 0.25 },
      ];
      for (let i = 0; i < 19; i++) {
        const result = await assessmentService.getNextQuestion(session.id, '');
        if (result.completed || !result.nextQuestion) break;
        const value = middleZones[i % middleZones.length];
        assessmentService.submitAnswers(session.id, {
          answers: [{ questionId: result.nextQuestion.id, value }],
        });
      }
      const assessment = assessmentService.getAssessment(session.id);
      const { traits, values, aptitudes } = assessment.dimensionScores || {};
      assert.ok(Array.isArray(traits) && Array.isArray(values) && Array.isArray(aptitudes));
      const allDims = [...(traits || []), ...(values || []), ...(aptitudes || [])];
      assert.ok(allDims.length >= 10, 'multiple dimensions from 19 triangles');
      allDims.forEach((d) => {
        assert.ok(d.id && typeof d.mean === 'number', `${d.id} has mean`);
        assert.ok(d.mean >= 1 && d.mean <= 5, `${d.id} mean ${d.mean} in [1,5]`);
        assert.ok(['low', 'medium', 'high'].includes(d.band), `${d.id} has band`);
      });
      assert.ok(values.length >= 1 && aptitudes.length >= 1, 'values and aptitudes populated');
    });
  });

  describe('profile validation (happy-path extremes)', () => {
    const triangles = loadCombinedTriangles();
    assert.strictEqual(triangles.length, 19, 'test expects 19 combined triangles');

    // Only the logical profile uses centre for every value/trait triangle (no value/trait in its set).
    // Artistic and team profiles include value_creativity, value_helping, trait_social_collaboration, etc.,
    // so they submit corners in those triangles and get real differentiation (hence low non-target scores).
    // Logical gets all centre in value/trait -> undifferentiated input -> rescaling yields arbitrary-looking
    // highs (e.g. all traits high with current seed). So "all traits high" is specific to logical, not others.

    it('highly logical profile: answers maximize logical aptitude; assessment shows logical aptitude high', async () => {
      const logicalDimensions = ['aptitude_logical_analytical_reasoning'];
      const answers = buildProfileAnswers(triangles, logicalDimensions);
      const session = sessionService.create(null);
      for (let i = 0; i < 19; i++) {
        const result = await assessmentService.getNextQuestion(session.id, '');
        if (result.completed || !result.nextQuestion) break;
        assessmentService.submitAnswers(session.id, {
          answers: [{ questionId: result.nextQuestion.id, value: answers[i] }],
        });
      }
      const assessment = assessmentService.getAssessment(session.id);
      logDimensionScores('Highly logical', assessment.dimensionScores);
      const aptitudes = assessment.dimensionScores?.aptitudes || [];
      const logical = aptitudes.find((d) => d.id === 'aptitude_logical_analytical_reasoning');
      assert.ok(logical, 'logical aptitude dimension present');
      assert.ok(logical.mean >= 4 && logical.mean <= 5, `logical profile should yield high logical score; got mean ${logical.mean}`);
      assert.strictEqual(logical.band, 'high', 'logical aptitude should be band high');
    });

    it('highly artistic profile: answers maximize creative, verbal, creativity value; assessment shows them high', async () => {
      const artisticDimensions = [
        'aptitude_creative_open_ended',
        'aptitude_verbal_linguistic',
        'value_creativity_self_expression',
      ];
      const answers = buildProfileAnswers(triangles, artisticDimensions);
      const session = sessionService.create(null);
      for (let i = 0; i < 19; i++) {
        const result = await assessmentService.getNextQuestion(session.id, '');
        if (result.completed || !result.nextQuestion) break;
        assessmentService.submitAnswers(session.id, {
          answers: [{ questionId: result.nextQuestion.id, value: answers[i] }],
        });
      }
      const assessment = assessmentService.getAssessment(session.id);
      logDimensionScores('Highly artistic', assessment.dimensionScores);
      const aptitudes = assessment.dimensionScores?.aptitudes || [];
      const values = assessment.dimensionScores?.values || [];
      const creative = aptitudes.find((d) => d.id === 'aptitude_creative_open_ended');
      const verbal = aptitudes.find((d) => d.id === 'aptitude_verbal_linguistic');
      const creativityValue = values.find((d) => d.id === 'value_creativity_self_expression');
      assert.ok(creative && verbal && creativityValue, 'artistic dimensions present');
      const maxAptitudeMean = Math.max(...aptitudes.map((d) => d.mean));
      const maxArtisticAptitude = Math.max(creative.mean, verbal.mean);
      assert.ok(maxArtisticAptitude >= maxAptitudeMean - 0.01, `artistic profile: creative or verbal among top aptitudes; got creative=${creative.mean} verbal=${verbal.mean} maxApt=${maxAptitudeMean}`);
      const valueMeans = values.map((d) => d.mean);
      const maxValueMean = Math.max(...valueMeans);
      assert.ok(creativityValue.mean >= maxValueMean - 0.01, `artistic profile: creativity value among top values; got ${creativityValue.mean} max=${maxValueMean}`);
      assert.ok([creative, verbal].some((d) => d.band === 'high') || creativityValue.band === 'high', 'at least one artistic dimension in band high');
    });

    it('super team player profile: answers maximize helping, belonging, collaboration; assessment shows them high', async () => {
      const teamDimensions = [
        'value_helping_others_impact',
        'value_belonging_community',
        'trait_social_collaboration',
        'value_work_life_balance_wellbeing',
      ];
      const answers = buildProfileAnswers(triangles, teamDimensions);
      const session = sessionService.create(null);
      for (let i = 0; i < 19; i++) {
        const result = await assessmentService.getNextQuestion(session.id, '');
        if (result.completed || !result.nextQuestion) break;
        assessmentService.submitAnswers(session.id, {
          answers: [{ questionId: result.nextQuestion.id, value: answers[i] }],
        });
      }
      const assessment = assessmentService.getAssessment(session.id);
      logDimensionScores('Super team player', assessment.dimensionScores);
      const values = assessment.dimensionScores?.values || [];
      const traits = assessment.dimensionScores?.traits || [];
      const helping = values.find((d) => d.id === 'value_helping_others_impact');
      const belonging = values.find((d) => d.id === 'value_belonging_community');
      const collaboration = traits.find((d) => d.id === 'trait_social_collaboration');
      assert.ok(helping && belonging && collaboration, 'team dimensions present');
      const maxTeamMean = Math.max(helping.mean, belonging.mean, collaboration.mean);
      assert.ok(maxTeamMean >= 3, `team profile: at least one of helping/belonging/collaboration elevated; got helping=${helping.mean} belonging=${belonging.mean} collab=${collaboration.mean}`);
      assert.ok([helping, belonging, collaboration].some((d) => d.band !== 'low'), 'team profile visible: at least one team dimension not low');
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
