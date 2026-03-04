'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { selectBestFromStore } = require('../../src/services/questionGeneration/storeFallback');

describe('questionGeneration/storeFallback', () => {
  describe('selectBestFromStore', () => {
    const desiredDimensionSet = [
      { dimensionType: 'aptitude', dimensionId: 'logical_analytical_reasoning' },
      { dimensionType: 'trait', dimensionId: 'adaptability' },
    ];

    it('returns null when candidates is empty', () => {
      const result = selectBestFromStore([], new Set(), desiredDimensionSet);
      assert.strictEqual(result, null);
    });

    it('returns null when all candidates are in usedSet', () => {
      const q = { title: 'Q?', type: 'single_choice', options: [{ text: 'A', value: 'a' }] };
      const hash = 'abc123';
      const result = selectBestFromStore(
        [{ question: q, dimensionSet: [], assessmentSummary: null, createdAt: '2025-01-01T00:00:00.000Z', contentHash: hash }],
        new Set([hash]),
        desiredDimensionSet
      );
      assert.strictEqual(result, null);
    });

    it('returns best candidate by dimension overlap score', () => {
      const q1 = { title: 'Q1', type: 'single_choice', options: [{ text: 'A', value: 'a' }] };
      const q2 = { title: 'Q2', type: 'single_choice', options: [{ text: 'B', value: 'b' }] };
      const q3 = { title: 'Q3', type: 'single_choice', options: [{ text: 'C', value: 'c' }] };
      const candidates = [
        {
          question: q1,
          dimensionSet: [{ dimensionType: 'aptitude', dimensionId: 'logical_analytical_reasoning' }],
          assessmentSummary: 's1',
          createdAt: '2025-01-01T00:00:00.000Z',
          contentHash: 'h1',
        },
        {
          question: q2,
          dimensionSet: [
            { dimensionType: 'aptitude', dimensionId: 'logical_analytical_reasoning' },
            { dimensionType: 'trait', dimensionId: 'adaptability' },
          ],
          assessmentSummary: 's2',
          createdAt: '2025-01-02T00:00:00.000Z',
          contentHash: 'h2',
        },
        {
          question: q3,
          dimensionSet: [],
          assessmentSummary: null,
          createdAt: '2025-01-03T00:00:00.000Z',
          contentHash: 'h3',
        },
      ];
      const result = selectBestFromStore(candidates, new Set(), desiredDimensionSet);
      assert.ok(result);
      assert.strictEqual(result.question.title, 'Q2');
      assert.strictEqual(result.assessmentSummary, 's2');
      assert.strictEqual(result.dimensionSet.length, 2);
    });

    it('tie-breaks by older createdAt when scores are equal', () => {
      const qOld = { title: 'Old', type: 'single_choice', options: [{ text: 'A', value: 'a' }] };
      const qNew = { title: 'New', type: 'single_choice', options: [{ text: 'B', value: 'b' }] };
      const oneDim = [{ dimensionType: 'aptitude', dimensionId: 'logical_analytical_reasoning' }];
      const candidates = [
        {
          question: qNew,
          dimensionSet: oneDim,
          assessmentSummary: null,
          createdAt: '2025-01-02T00:00:00.000Z',
          contentHash: 'hNew',
        },
        {
          question: qOld,
          dimensionSet: oneDim,
          assessmentSummary: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          contentHash: 'hOld',
        },
      ];
      const result = selectBestFromStore(candidates, new Set(), desiredDimensionSet);
      assert.ok(result);
      assert.strictEqual(result.question.title, 'Old');
    });

    it('excludes used items and picks best among unused', () => {
      const qUsed = { title: 'Used', type: 'single_choice', options: [{ text: 'A', value: 'a' }] };
      const qUnused = { title: 'Unused', type: 'single_choice', options: [{ text: 'B', value: 'b' }] };
      const twoDims = [
        { dimensionType: 'aptitude', dimensionId: 'logical_analytical_reasoning' },
        { dimensionType: 'trait', dimensionId: 'adaptability' },
      ];
      const candidates = [
        {
          question: qUsed,
          dimensionSet: twoDims,
          assessmentSummary: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          contentHash: 'usedHash',
        },
        {
          question: qUnused,
          dimensionSet: [{ dimensionType: 'aptitude', dimensionId: 'logical_analytical_reasoning' }],
          assessmentSummary: null,
          createdAt: '2025-01-02T00:00:00.000Z',
          contentHash: 'unusedHash',
        },
      ];
      const result = selectBestFromStore(candidates, new Set(['usedHash']), desiredDimensionSet);
      assert.ok(result);
      assert.strictEqual(result.question.title, 'Unused');
    });
  });
});
