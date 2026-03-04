'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const ollamaClient = require('../src/lib/ollamaClient');
const { validateNextQuestionObject, generateScenarioQuestion } = require('../src/lib/ollamaInterview');

describe('ollamaInterview', () => {
  describe('generateScenarioQuestion', () => {
    let originalChat;

    beforeEach(() => {
      originalChat = ollamaClient.chat;
    });

    afterEach(() => {
      ollamaClient.chat = originalChat;
    });

    it('returns question when first LLM response is valid and does not call LLM again', async () => {
      const validResponse = JSON.stringify({
        completed: false,
        nextQuestion: {
          title: 'Pick one',
          type: 'single_choice',
          options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
        },
        assessmentSummary: 'Summary.',
      });
      let callCount = 0;
      ollamaClient.chat = async (messages) => {
        callCount += 1;
        assert.strictEqual(messages.length, 2, 'first call: system + user');
        return { content: validResponse };
      };

      const dimensionSet = [
        { dimensionType: 'trait', dimensionId: 'x', name: 'X', question_hints: [], how_measured_or_observed: '' },
      ];
      const result = await generateScenarioQuestion(dimensionSet, [], [], null, null);

      assert.strictEqual(callCount, 1);
      assert.ok(result.nextQuestion);
      assert.strictEqual(result.nextQuestion.title, 'Pick one');
      assert.strictEqual(result.nextQuestion.options.length, 2);
    });

    it('sends validation errors back to LLM and returns corrected response when second response is valid', async () => {
      const dimensionSetWithScale = [
        {
          dimensionType: 'trait',
          dimensionId: 'collab',
          name: 'Collaboration',
          question_hints: [],
          how_measured_or_observed: '',
          score_scale: { min: 1, max: 5, interpretation: { low: 'L', medium: 'M', high: 'H' } },
        },
      ];
      const firstResponseInvalid = JSON.stringify({
        completed: false,
        nextQuestion: {
          title: 'Team?',
          type: 'single_choice',
          options: [
            { text: 'Solo', value: 'solo' },
            { text: 'Team', value: 'team' },
          ],
        },
      });
      const secondResponseValid = JSON.stringify({
        completed: false,
        nextQuestion: {
          title: 'Team?',
          description: 'Your team has to present next week. You can prepare solo or with others.',
          type: 'single_choice',
          options: [
            { text: 'Solo', value: 'solo', dimensionScores: { collab: 1 } },
            { text: 'Team', value: 'team', dimensionScores: { collab: 5 } },
          ],
        },
      });

      let callCount = 0;
      let secondCallMessages = null;
      ollamaClient.chat = async (messages) => {
        callCount += 1;
        if (callCount === 1) return { content: firstResponseInvalid };
        secondCallMessages = messages;
        return { content: secondResponseValid };
      };

      const result = await generateScenarioQuestion(dimensionSetWithScale, [], [], null, null);

      assert.strictEqual(callCount, 2);
      assert.ok(secondCallMessages, 'second call should have been made');
      assert.strictEqual(secondCallMessages.length, 4, 'system, user, assistant, correction user');
      assert.strictEqual(secondCallMessages[2].role, 'assistant');
      assert.strictEqual(secondCallMessages[3].role, 'user');
      assert.ok(secondCallMessages[3].content.includes('Validation errors'), 'correction message lists errors');
      assert.ok(secondCallMessages[3].content.includes('dimensionScores') || secondCallMessages[3].content.includes('collab'), 'correction mentions dimensionScores or dimension id');
      assert.ok(result.nextQuestion);
      assert.strictEqual(result.nextQuestion.options[0].dimensionScores.collab, 1);
      assert.strictEqual(result.nextQuestion.options[1].dimensionScores.collab, 5);
    });

    it('returns null when first response invalid and second response still invalid', async () => {
      const dimensionSetWithScale = [
        {
          dimensionType: 'trait',
          dimensionId: 'collab',
          name: 'Collaboration',
          question_hints: [],
          how_measured_or_observed: '',
          score_scale: { min: 1, max: 5, interpretation: { low: 'L', medium: 'M', high: 'H' } },
        },
      ];
      const invalidNoScores = JSON.stringify({
        completed: false,
        nextQuestion: {
          title: 'Team?',
          type: 'single_choice',
          options: [{ text: 'Solo', value: 'solo' }, { text: 'Team', value: 'team' }],
        },
      });

      let callCount = 0;
      ollamaClient.chat = async (messages) => {
        callCount += 1;
        return { content: invalidNoScores };
      };

      const result = await generateScenarioQuestion(dimensionSetWithScale, [], [], null, null);

      assert.strictEqual(callCount, 2);
      assert.strictEqual(result.nextQuestion, null);
    });
  });

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
