'use strict';

/**
 * Unit tests for the Bayesian triangle scorer (zone detection, scoring, edge cases).
 * Does not depend on BFT_ASSESSMENT_MODE or assessmentService.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const scorer = require('../src/lib/bayesianTriangleScorer');

describe('bayesianTriangleScorer', () => {
  describe('detectZone', () => {
    it('returns corner when max weight >= 0.7', () => {
      assert.strictEqual(scorer.detectZone([0.74, 0.13, 0.13]), 'corner');
      assert.strictEqual(scorer.detectZone([0.7, 0.15, 0.15]), 'corner');
      assert.strictEqual(scorer.detectZone([0.1, 0.8, 0.1]), 'corner');
    });

    it('returns centre when nothing dominant and min >= 0.2', () => {
      assert.strictEqual(scorer.detectZone([1 / 3, 1 / 3, 1 / 3]), 'centre');
      assert.strictEqual(scorer.detectZone([0.38, 0.35, 0.27]), 'centre');
      assert.strictEqual(scorer.detectZone([0.4, 0.35, 0.25]), 'centre');
    });

    it('returns edge when min < 0.2 and two co-equal (mid 0.35-0.65, close to max)', () => {
      assert.strictEqual(scorer.detectZone([0.5, 0.5, 0]), 'edge');
      assert.strictEqual(scorer.detectZone([0.45, 0.45, 0.1]), 'edge');
    });

    it('returns near_corner when max >= 0.55 and min < 0.2', () => {
      assert.strictEqual(scorer.detectZone([0.65, 0.28, 0.07]), 'near_corner');
      assert.strictEqual(scorer.detectZone([0.6, 0.25, 0.15]), 'near_corner');
    });

    it('returns near_edge when min < 0.2 but not corner/edge/near_corner', () => {
      // max < 0.55, mid outside [0.35, 0.65] so not edge
      assert.strictEqual(scorer.detectZone([0.52, 0.31, 0.17]), 'near_edge');
    });

    it('normalises weights by sum before classifying', () => {
      assert.strictEqual(scorer.detectZone([74, 13, 13]), 'corner');
      assert.strictEqual(scorer.detectZone([1, 1, 1]), 'centre');
    });

    it('returns centre for invalid or non-3 weights', () => {
      assert.strictEqual(scorer.detectZone([]), 'centre');
      assert.strictEqual(scorer.detectZone([0.5, 0.5]), 'centre');
      assert.strictEqual(scorer.detectZone([0, 0, 0]), 'centre');
      assert.strictEqual(scorer.detectZone([1, 0]), 'centre');
    });

    it('accepts object form { a, b, c }', () => {
      assert.strictEqual(scorer.detectZone({ a: 0.74, b: 0.13, c: 0.13 }), 'corner');
      assert.strictEqual(scorer.detectZone({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }), 'centre');
    });
  });

  describe('buildDimIndex', () => {
    it('returns unique sorted dimIds and index map', () => {
      const ids = ['value_c', 'value_a', 'value_b', 'value_a'];
      const { dimIndex, dimIds } = scorer.buildDimIndex(ids);
      assert.deepStrictEqual(dimIds, ['value_a', 'value_b', 'value_c']);
      assert.strictEqual(dimIndex['value_a'], 0);
      assert.strictEqual(dimIndex['value_b'], 1);
      assert.strictEqual(dimIndex['value_c'], 2);
    });

    it('handles empty array', () => {
      const { dimIndex, dimIds } = scorer.buildDimIndex([]);
      assert.strictEqual(dimIds.length, 0);
      assert.strictEqual(Object.keys(dimIndex).length, 0);
    });

    it('filters out falsy ids', () => {
      const { dimIds } = scorer.buildDimIndex(['a', null, 'b', undefined, 'a', '']);
      assert.deepStrictEqual(dimIds, ['a', 'b']);
    });
  });

  describe('scoreTriangleResponses', () => {
    it('returns empty profile and note when rawResponses is empty', () => {
      const out = scorer.scoreTriangleResponses([]);
      assert.strictEqual(out.profile.length, 0);
      assert.strictEqual(out.dimIds.length, 0);
      assert.ok(out.mcmc_diagnostics.note);
    });

    it('returns empty profile when rawResponses is null or not array', () => {
      assert.strictEqual(scorer.scoreTriangleResponses(null).profile.length, 0);
      assert.strictEqual(scorer.scoreTriangleResponses(undefined).profile.length, 0);
      assert.strictEqual(scorer.scoreTriangleResponses({}).profile.length, 0);
    });

    it('accepts weights as a,b,c when weights array missing', () => {
      const out = scorer.scoreTriangleResponses([
        { dims: ['A', 'B', 'C'], a: 1, b: 0, c: 0 },
      ]);
      assert.strictEqual(out.profile.length, 3);
      const a = out.profile.find((p) => p.dimension_id === 'A');
      assert.ok(a);
      assert.ok(a.score_1_to_5 >= 4 && a.score_1_to_5 <= 5);
    });

    it('normalises weights that do not sum to 1', () => {
      const out = scorer.scoreTriangleResponses([
        { dims: ['X', 'Y', 'Z'], weights: [2, 2, 2] },
      ], { seed: 123, nSamples: 500, nWarmup: 100 });
      assert.strictEqual(out.profile.length, 3);
      out.profile.forEach((p) => {
        assert.ok(p.score_1_to_5 >= 1 && p.score_1_to_5 <= 5);
      });
    });

    it('skips responses with dims not in dimIndex when using provided dimIndex', () => {
      const dimIndex = { A: 0, B: 1, C: 2 };
      const out = scorer.scoreTriangleResponses([
        { dims: ['A', 'B', 'C'], weights: [1, 0, 0] },
        { dims: ['A', 'B', 'D'], weights: [0, 1, 0] },
      ], { dimIndex });
      assert.strictEqual(out.profile.length, 3);
      assert.strictEqual(out.mcmc_diagnostics.n_triangles, 1);
    });

    it('returns note when all responses are invalid (dims missing or wrong length)', () => {
      const out = scorer.scoreTriangleResponses([
        { dims: ['A', 'B'], weights: [0.5, 0.5] },
      ]);
      assert.strictEqual(out.profile.length, 0);
      assert.ok(out.mcmc_diagnostics.note);
    });

    it('is deterministic with same seed', () => {
      const responses = [
        { dims: ['A', 'B', 'C'], weights: [0.6, 0.3, 0.1] },
      ];
      const out1 = scorer.scoreTriangleResponses(responses, { seed: 99, nSamples: 200, nWarmup: 50 });
      const out2 = scorer.scoreTriangleResponses(responses, { seed: 99, nSamples: 200, nWarmup: 50 });
      assert.deepStrictEqual(
        out1.profile.map((p) => p.score_1_to_5),
        out2.profile.map((p) => p.score_1_to_5)
      );
    });

    it('produces scores in [1, 5] for single triangle', () => {
      const out = scorer.scoreTriangleResponses([
        { dims: ['A', 'B', 'C'], weights: [0.5, 0.3, 0.2] },
      ], { seed: 1, nSamples: 300, nWarmup: 100 });
      out.profile.forEach((p) => {
        assert.ok(p.score_1_to_5 >= 1 && p.score_1_to_5 <= 5, `${p.dimension_id} score ${p.score_1_to_5}`);
      });
    });

    it('dominant vertex gets highest score in single triangle', () => {
      const out = scorer.scoreTriangleResponses([
        { dims: ['A', 'B', 'C'], weights: [0.85, 0.1, 0.05] },
      ], { seed: 2, nSamples: 500, nWarmup: 150 });
      const scores = out.profile.map((p) => ({ id: p.dimension_id, score: p.score_1_to_5 }));
      const a = scores.find((s) => s.id === 'A');
      const b = scores.find((s) => s.id === 'B');
      const c = scores.find((s) => s.id === 'C');
      assert.ok(a.score > b.score && a.score > c.score);
    });

    it('uses explicit zone when provided', () => {
      const out = scorer.scoreTriangleResponses([
        { dims: ['A', 'B', 'C'], weights: [0.4, 0.35, 0.25], zone: 'corner' },
      ], { seed: 3, nSamples: 200, nWarmup: 50 });
      assert.strictEqual(out.profile.length, 3);
    });

    it('handles zero sum weights by using (1/3, 1/3, 1/3)', () => {
      const out = scorer.scoreTriangleResponses([
        { dims: ['A', 'B', 'C'], weights: [0, 0, 0] },
      ], { seed: 4, nSamples: 200, nWarmup: 50 });
      assert.strictEqual(out.profile.length, 3);
      out.profile.forEach((p) => assert.ok(p.score_1_to_5 >= 1 && p.score_1_to_5 <= 5));
    });

    it('n_triangles in profile reflects how many triangles contained that dimension', () => {
      const out = scorer.scoreTriangleResponses([
        { dims: ['A', 'B', 'C'], weights: [1, 0, 0] },
        { dims: ['A', 'D', 'E'], weights: [0.5, 0.25, 0.25] },
      ], { seed: 5, nSamples: 300, nWarmup: 100 });
      const a = out.profile.find((p) => p.dimension_id === 'A');
      assert.strictEqual(a.n_triangles, 2);
      const b = out.profile.find((p) => p.dimension_id === 'B');
      assert.strictEqual(b.n_triangles, 1);
    });

    it('mcmc_diagnostics includes acceptance_rate and n_samples', () => {
      const out = scorer.scoreTriangleResponses([
        { dims: ['A', 'B', 'C'], weights: [0.5, 0.3, 0.2] },
      ], { nSamples: 100, nWarmup: 20 });
      assert.ok(typeof out.mcmc_diagnostics.acceptance_rate === 'number');
      assert.strictEqual(out.mcmc_diagnostics.n_samples, 100);
      assert.strictEqual(out.mcmc_diagnostics.n_triangles, 1);
    });
  });

  describe('ZONE_PHI and REJECTION_STRENGTH', () => {
    it('exports zone concentration for all five zones', () => {
      assert.strictEqual(scorer.ZONE_PHI.corner, 12);
      assert.strictEqual(scorer.ZONE_PHI.near_corner, 9);
      assert.strictEqual(scorer.ZONE_PHI.edge, 5);
      assert.strictEqual(scorer.ZONE_PHI.near_edge, 4);
      assert.strictEqual(scorer.ZONE_PHI.centre, 2);
    });

    it('exports rejection strength with centre zero', () => {
      assert.strictEqual(scorer.REJECTION_STRENGTH.centre, 0);
      assert.ok(scorer.REJECTION_STRENGTH.corner > 0);
    });
  });
});
