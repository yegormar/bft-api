'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { validateNextQuestionObject } = require('../src/lib/ollamaInterview');

describe('ollamaInterview', () => {
  describe('validateNextQuestionObject', () => {
    it('accepts type single_choice', () => {
      const q = {
        title: 'Pick one',
        type: 'single_choice',
        options: [
          { text: 'A', value: 'a' },
          { text: 'B', value: 'b' },
        ],
      };
      const r = validateNextQuestionObject(q, true);
      assert.strictEqual(r.valid, true);
      assert.strictEqual(r.errors.length, 0);
    });

    it('accepts type multi_choice', () => {
      const q = {
        title: 'Pick up to two',
        type: 'multi_choice',
        maxSelections: 2,
        options: [
          { text: 'A', value: 'a' },
          { text: 'B', value: 'b' },
          { text: 'C', value: 'c' },
        ],
      };
      const r = validateNextQuestionObject(q, true);
      assert.strictEqual(r.valid, true);
      assert.strictEqual(r.errors.length, 0);
    });

    it('accepts type rank without maxSelections', () => {
      const q = {
        title: 'Order from most to least',
        type: 'rank',
        options: [
          { text: 'First option', value: 'opt1' },
          { text: 'Second option', value: 'opt2' },
          { text: 'Third option', value: 'opt3' },
        ],
      };
      const r = validateNextQuestionObject(q, true);
      assert.strictEqual(r.valid, true, r.errors.join('; '));
      assert.strictEqual(r.errors.length, 0);
    });

    it('rejects invalid type', () => {
      const q = {
        title: 'Bad type',
        type: 'free_text',
        options: [{ text: 'Only', value: 'v' }],
      };
      const r = validateNextQuestionObject(q, true);
      assert.strictEqual(r.valid, false);
      assert.ok(r.errors.some((e) => e.includes('single_choice') || e.includes('rank')));
    });

    it('rejects empty options', () => {
      const q = {
        title: 'No options',
        type: 'single_choice',
        options: [],
      };
      const r = validateNextQuestionObject(q, true);
      assert.strictEqual(r.valid, false);
      assert.ok(r.errors.some((e) => e.includes('options')));
    });
  });
});
