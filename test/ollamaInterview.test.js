'use strict';

process.env.BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE = 'conf/scenario_step1_instructions.txt';
process.env.BFT_SCENARIO_STEP2_INSTRUCTIONS_FILE = 'conf/scenario_step2_instructions.txt';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const ollamaClient = require('../src/lib/ollamaClient');
const {
  validateNextQuestionObject,
  generateScenarioQuestion,
  getScenarioOnlySystemPrompt,
  buildScenarioOnlyUserPrompt,
  checkForbiddenWords,
  getForbiddenWordsList,
} = require('../src/lib/ollamaInterview');

describe('ollamaInterview', () => {
  describe('generateScenarioQuestion', () => {
    let originalChat;

    beforeEach(() => {
      originalChat = ollamaClient.chat;
    });

    afterEach(() => {
      ollamaClient.chat = originalChat;
    });

    it('returns question when step 1 and step 2 LLM responses are valid (two-step flow)', async () => {
      const step1Response = JSON.stringify({
        completed: false,
        nextQuestion: {
          title: 'Pick one',
          description: 'A short scenario.',
          type: 'single_choice',
          options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
        },
        assessmentSummary: 'Summary.',
      });
      const step2Response = JSON.stringify({
        optionScores: [
          { dimensionScores: {} },
          { dimensionScores: {} },
        ],
      });
      let callCount = 0;
      ollamaClient.chat = async (messages) => {
        callCount += 1;
        assert.strictEqual(messages.length, 2, 'each call: system + user');
        if (callCount === 1) return { content: step1Response };
        return { content: step2Response };
      };

      const dimensionSet = [
        { dimensionType: 'trait', dimensionId: 'x', name: 'X', question_hints: [], how_measured_or_observed: '' },
      ];
      const result = await generateScenarioQuestion(dimensionSet, [], [], null, null);

      assert.strictEqual(callCount, 2, 'step 1 then step 2');
      assert.ok(result.nextQuestion);
      assert.strictEqual(result.nextQuestion.title, 'Pick one');
      assert.strictEqual(result.nextQuestion.options.length, 2);
      assert.ok(typeof result.nextQuestion.options[0].dimensionScores === 'object');
      assert.ok(typeof result.nextQuestion.options[1].dimensionScores === 'object');
    });

    it('sends step 2 validation errors back to LLM and returns corrected response when step 2 retry is valid', async () => {
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
      const step1Response = JSON.stringify({
        completed: false,
        nextQuestion: {
          title: 'Team?',
          description: 'Your team has to present next week. You can prepare solo or with others.',
          type: 'single_choice',
          options: [{ text: 'Solo', value: 'solo' }, { text: 'Team', value: 'team' }],
        },
      });
      const step2Invalid = JSON.stringify({ optionScores: [] });
      const step2Valid = JSON.stringify({
        optionScores: [
          { dimensionScores: { collab: 1 } },
          { dimensionScores: { collab: 5 } },
        ],
      });

      let callCount = 0;
      let thirdCallMessages = null;
      ollamaClient.chat = async (messages) => {
        callCount += 1;
        if (callCount === 1) return { content: step1Response };
        if (callCount === 2) return { content: step2Invalid };
        thirdCallMessages = messages;
        return { content: step2Valid };
      };

      const result = await generateScenarioQuestion(dimensionSetWithScale, [], [], null, null);

      assert.strictEqual(callCount, 3, 'step 1, step 2 invalid, step 2 correction');
      assert.ok(thirdCallMessages, 'third call (step 2 correction) should have been made');
      assert.strictEqual(thirdCallMessages.length, 4, 'system, user, assistant, correction user');
      assert.ok(thirdCallMessages[3].content.includes('Validation errors') || thirdCallMessages[3].content.includes('optionScores'), 'correction message lists errors');
      assert.ok(result.nextQuestion);
      assert.strictEqual(result.nextQuestion.options[0].dimensionScores.collab, 1);
      assert.strictEqual(result.nextQuestion.options[1].dimensionScores.collab, 5);
    });

    it('returns null when step 1 response invalid and step 1 retry still invalid', async () => {
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
      const invalidStep1EmptyOptions = JSON.stringify({
        completed: false,
        nextQuestion: {
          title: 'Team?',
          type: 'single_choice',
          options: [],
        },
      });

      let callCount = 0;
      ollamaClient.chat = async (messages) => {
        callCount += 1;
        return { content: invalidStep1EmptyOptions };
      };

      const result = await generateScenarioQuestion(dimensionSetWithScale, [], [], null, null);

      assert.strictEqual(callCount, 2, 'step 1 then step 1 correction');
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

    it('allows partial dimensionScores when allowPartialDimensionScores is true', () => {
      const q = {
        title: 'Pick one',
        description: 'A scenario.',
        type: 'single_choice',
        options: [
          { text: 'A', value: 'a', dimensionScores: { collab: 5 } },
          { text: 'B', value: 'b', dimensionScores: { collab: 1 } },
        ],
      };
      const scoringOptions = {
        expectedDimensionIds: ['collab', 'belonging'],
        scoreMin: 1,
        scoreMax: 5,
        allowPartialDimensionScores: true,
      };
      const r = validateNextQuestionObject(q, true, scoringOptions);
      assert.strictEqual(r.valid, true, r.errors.join('; '));
      assert.strictEqual(r.errors.length, 0);
    });

    it('rejects extra dimension ID when allowPartialDimensionScores is true', () => {
      const q = {
        title: 'Pick one',
        description: 'A scenario.',
        type: 'single_choice',
        options: [
          { text: 'A', value: 'a', dimensionScores: { collab: 5, unknown_dim: 3 } },
        ],
      };
      const scoringOptions = {
        expectedDimensionIds: ['collab'],
        scoreMin: 1,
        scoreMax: 5,
        allowPartialDimensionScores: true,
      };
      const r = validateNextQuestionObject(q, true, scoringOptions);
      assert.strictEqual(r.valid, false);
      assert.ok(r.errors.some((e) => e.includes('unknown_dim') || e.includes('unexpected')));
    });
  });

  describe('two-step flow with non-1-5 score scale', () => {
    it('accepts dimensionScores in 1-10 range when score_scale is min=1 max=10', async () => {
      const dimensionSetWithScale = [
        {
          dimensionType: 'value',
          dimensionId: 'impact',
          name: 'Impact',
          question_hints: [],
          how_measured_or_observed: '',
          score_scale: { min: 1, max: 10, interpretation: { low: 'L', medium: 'M', high: 'H' } },
        },
      ];
      const step1Response = JSON.stringify({
        completed: false,
        nextQuestion: {
          title: 'Impact?',
          description: 'You can help one person a lot or many a little.',
          type: 'single_choice',
          options: [{ text: 'One', value: 'one' }, { text: 'Many', value: 'many' }],
        },
      });
      const step2Response = JSON.stringify({
        optionScores: [
          { dimensionScores: { impact: 9 } },
          { dimensionScores: { impact: 3 } },
        ],
      });
      let callCount = 0;
      ollamaClient.chat = async (messages) => {
        callCount += 1;
        if (callCount === 1) return { content: step1Response };
        return { content: step2Response };
      };

      const result = await generateScenarioQuestion(dimensionSetWithScale, [], [], null, null);

      assert.strictEqual(callCount, 2);
      assert.ok(result.nextQuestion);
      assert.strictEqual(result.nextQuestion.options[0].dimensionScores.impact, 9);
      assert.strictEqual(result.nextQuestion.options[1].dimensionScores.impact, 3);
    });
  });

  describe('getScenarioOnlySystemPrompt', () => {
    it('includes design instructions when scenario_design_instructions.txt is present', () => {
      const prompt = getScenarioOnlySystemPrompt();
      assert.ok(prompt.includes('INDIRECT PROBING') || prompt.includes('CORE PRINCIPLE'), 'step-1 system prompt should include design instructions');
      assert.ok(prompt.includes('NEVER USE THESE') || prompt.includes('TELEGRAPHING'), 'design instructions should include forbidden-words section');
    });
  });

  describe('buildScenarioOnlyUserPrompt', () => {
    it('with dilemmaAnchor omits theme, primary idea, and question_hints', () => {
      const primaryDimension = {
        name: 'Human-human collaboration',
        description: 'Team vs solo.',
        how_measured_or_observed: 'Preference for team.',
        question_hints: ['Do you prefer working with others?'],
      };
      const batchTheme = 'Team, belonging, and ownership';
      const prompt = buildScenarioOnlyUserPrompt(
        primaryDimension,
        batchTheme,
        [],
        [],
        null,
        'A situation where something is submitted and there is a choice about whose name is on it.'
      );
      assert.ok(prompt.includes('Dilemma anchor'), 'should include dilemma anchor line');
      assert.ok(prompt.includes('whose name is on it'), 'should include the anchor text');
      assert.ok(!prompt.includes('Human-human collaboration'), 'should not include primary dimension name');
      assert.ok(!prompt.includes('Theme for this scenario'), 'should not include theme');
      assert.ok(!prompt.includes('Hints for the dilemma'), 'should not include hints');
      assert.ok(!prompt.includes('Do you prefer working with others'), 'should not include question_hints');
    });

    it('without dilemmaAnchor uses generic instruction and omits theme/dimension', () => {
      const primaryDimension = { name: 'Collaboration', question_hints: ['Team or solo?'] };
      const prompt = buildScenarioOnlyUserPrompt(primaryDimension, 'Some theme', [], [], null, null);
      assert.ok(prompt.includes('Design one concrete dilemma'), 'should include generic instruction');
      assert.ok(!prompt.includes('Primary idea'), 'should not include primary idea');
      assert.ok(!prompt.includes('Theme for this scenario'), 'should not include theme');
    });
  });

  describe('checkForbiddenWords', () => {
    it('returns ok: true when no forbidden term appears', () => {
      const list = ['responsibility', 'balance'];
      const question = {
        title: 'The Last-Minute Demo',
        description: 'Your team has a demo in two hours. One path is to prepare alone; another is to split prep with a teammate.',
        options: [{ text: "I'd prepare alone and present." }, { text: "I'd coordinate with my teammate and present together." }],
      };
      const r = checkForbiddenWords(question, list);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.found.length, 0);
    });

    it('returns ok: false and found when forbidden term appears in title', () => {
      const list = ['responsibility', 'balance'];
      const question = {
        title: 'Taking full responsibility',
        description: 'A scenario.',
        options: [{ text: 'Option A', value: 'a' }],
      };
      const r = checkForbiddenWords(question, list);
      assert.strictEqual(r.ok, false);
      assert.ok(r.found.includes('responsibility'));
    });

    it('returns ok: false when forbidden term appears in description or option text', () => {
      const list = ['split the work'];
      const question = {
        title: 'Demo',
        description: 'You can split the work with your teammate or do it alone.',
        options: [{ text: 'Do it alone', value: 'a' }, { text: 'Split with teammate', value: 'b' }],
      };
      const r = checkForbiddenWords(question, list);
      assert.strictEqual(r.ok, false);
      assert.ok(r.found.includes('split the work'));
    });
  });

  describe('getForbiddenWordsList', () => {
    it('returns a non-empty array (default or from file)', () => {
      const list = getForbiddenWordsList();
      assert.ok(Array.isArray(list));
      assert.ok(list.length > 0);
      assert.ok(list.some((t) => t.includes('responsibility') || t.includes('balance')));
    });
  });
});
