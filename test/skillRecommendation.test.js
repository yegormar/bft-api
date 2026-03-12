'use strict';

/**
 * Tests for dimension-to-skill applicability calculation.
 * Validates that getSkillsWithApplicability uses only dimension_skill_mapping.json
 * and dimension means (band is not used). Applicability = weighted average of
 * dimension means by mapping weights, clamped 1-5; 0 when no link.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const skillRecommendation = require('../src/lib/skillRecommendation');

function applicabilityBySkillId(skills) {
  const map = new Map();
  for (const s of skills) map.set(s.id, s.applicability);
  return map;
}

describe('skillRecommendation.getSkillsWithApplicability', () => {
  it('returns skills with applicability 0 when no dimension scores provided', () => {
    const result = skillRecommendation.getSkillsWithApplicability({});
    assert.ok(Array.isArray(result));
    assert.ok(result.length > 0);
    const app = applicabilityBySkillId(result);
    for (const [, a] of app) assert.strictEqual(a, 0);
  });

  it('returns skills with applicability 0 when traits/values/aptitudes are empty', () => {
    const result = skillRecommendation.getSkillsWithApplicability({
      traits: [],
      values: [],
      aptitudes: [],
    });
    const app = applicabilityBySkillId(result);
    for (const [, a] of app) assert.strictEqual(a, 0);
  });

  it('computes applicability from single dimension: weighted average = mean', () => {
    // aptitude_logical_analytical_reasoning has structured_problem_solving weight 0.7.
    // Single dimension -> applicability = (mean * w) / w = mean.
    const result = skillRecommendation.getSkillsWithApplicability({
      traits: [],
      values: [],
      aptitudes: [{ id: 'aptitude_logical_analytical_reasoning', mean: 4, band: 'high' }],
    });
    const app = applicabilityBySkillId(result);
    assert.strictEqual(app.get('structured_problem_solving'), 4);
  });

  it('ignores band: same applicability for same means regardless of band', () => {
    const dim = { id: 'aptitude_logical_analytical_reasoning', mean: 3 };
    const withHigh = skillRecommendation.getSkillsWithApplicability({
      traits: [],
      values: [],
      aptitudes: [{ ...dim, band: 'high' }],
    });
    const withLow = skillRecommendation.getSkillsWithApplicability({
      traits: [],
      values: [],
      aptitudes: [{ ...dim, band: 'low' }],
    });
    const appHigh = applicabilityBySkillId(withHigh);
    const appLow = applicabilityBySkillId(withLow);
    for (const id of appHigh.keys()) {
      assert.strictEqual(appHigh.get(id), appLow.get(id), `skill ${id} should not depend on band`);
    }
  });

  it('computes weighted average across multiple dimensions for one skill', () => {
    // structured_problem_solving: logical 0.7, verbal 0.2 (from mapping).
    // (5*0.7 + 1*0.2) / (0.7+0.2) = 3.7/0.9 ≈ 4.111
    const result = skillRecommendation.getSkillsWithApplicability({
      traits: [],
      values: [],
      aptitudes: [
        { id: 'aptitude_logical_analytical_reasoning', mean: 5 },
        { id: 'aptitude_verbal_linguistic', mean: 1 },
      ],
    });
    const app = applicabilityBySkillId(result);
    const expected = (5 * 0.7 + 1 * 0.2) / (0.7 + 0.2);
    assert.ok(Math.abs((app.get('structured_problem_solving') || 0) - expected) < 0.01);
  });

  it('instruction_clarity: verbal weight 0.8 dominates when only verbal given', () => {
    const result = skillRecommendation.getSkillsWithApplicability({
      traits: [],
      values: [],
      aptitudes: [{ id: 'aptitude_verbal_linguistic', mean: 5 }],
    });
    const app = applicabilityBySkillId(result);
    assert.strictEqual(app.get('instruction_clarity'), 5);
  });

  it('clamps applicability to 1-5', () => {
    // All dimensions low (mean 1) -> weighted average 1, clamped to 1.
    const result = skillRecommendation.getSkillsWithApplicability({
      traits: [],
      values: [],
      aptitudes: [
        { id: 'aptitude_logical_analytical_reasoning', mean: 1 },
        { id: 'aptitude_verbal_linguistic', mean: 1 },
      ],
    });
    for (const s of result) {
      assert.ok(s.applicability >= 0 && s.applicability <= 5, `skill ${s.id} applicability must be in [0,5], got ${s.applicability}`);
      if (s.applicability > 0) assert.ok(s.applicability >= 1, `positive applicability must be >= 1, got ${s.applicability}`);
    }
  });

  it('returns result sorted by applicability descending', () => {
    const result = skillRecommendation.getSkillsWithApplicability({
      traits: [],
      values: [],
      aptitudes: [
        { id: 'aptitude_logical_analytical_reasoning', mean: 4 },
        { id: 'aptitude_verbal_linguistic', mean: 3 },
      ],
    });
    for (let i = 1; i < result.length; i++) {
      assert.ok(
        (result[i].applicability ?? 0) <= (result[i - 1].applicability ?? 0),
        `expected applicability descending at index ${i}`
      );
    }
  });

  it('includes only dimensions present in mapping; unknown dimension id is skipped', () => {
    const result = skillRecommendation.getSkillsWithApplicability({
      traits: [],
      values: [],
      aptitudes: [
        { id: 'aptitude_logical_analytical_reasoning', mean: 5 },
        { id: 'nonexistent_dimension_id', mean: 1 },
      ],
    });
    const app = applicabilityBySkillId(result);
    assert.strictEqual(app.get('structured_problem_solving'), 5);
  });

  it('each skill has applicability and ai_future_score', () => {
    const result = skillRecommendation.getSkillsWithApplicability({
      aptitudes: [{ id: 'aptitude_logical_analytical_reasoning', mean: 3 }],
      traits: [],
      values: [],
    });
    for (const s of result) {
      assert.ok(typeof s.applicability === 'number', `skill ${s.id} has applicability`);
      assert.ok(typeof s.ai_future_score === 'number' && s.ai_future_score >= 0 && s.ai_future_score <= 1, `skill ${s.id} has ai_future_score 0-1`);
    }
  });
});
