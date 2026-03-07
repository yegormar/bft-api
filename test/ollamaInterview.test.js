'use strict';

process.env.BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE = 'conf/scenario_step1.txt';
process.env.BFT_SCENARIO_STEP3_INSTRUCTIONS_FILE = 'conf/scenario_step3.txt';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { createFakeOllama, threeStepResponses } = require('./fakeOllama');
const {
  validateNextQuestionObject,
  generateScenarioQuestion,
  getScenarioOnlySystemPrompt,
  buildScenarioStep1UserPrompt,
  getScenarioStep1SystemPromptWithDimension,
  getScenarioStep3SystemPrompt,
  parseStep1PlainText,
  runCritiquePass,
} = require('../src/lib/ollamaInterview');

describe('ollamaInterview', () => {
  describe('generateScenarioQuestion', () => {
    const step1PlainText = `TITLE:
Pick one

SITUATION:
A short scenario.

OPTIONS:
- Option A
- Option B`;

    it('returns question when step 1, critique (judge PASS), and step 3 are valid', async () => {
      const step3Question = {
        title: 'Pick one',
        description: 'A short scenario.',
        type: 'single_choice',
        options: [
          { text: 'Option A', value: 'a', dimensionScores: { x: 1 } },
          { text: 'Option B', value: 'b', dimensionScores: { x: 2 } },
        ],
      };
      const responses = threeStepResponses(step1PlainText, 'Something about preferences.', 'PASS', step3Question);
      const fake = createFakeOllama(responses);

      const dimensionSet = [
        { dimensionType: 'trait', dimensionId: 'x', name: 'X', question_hints: [], how_measured_or_observed: '', score_scale: { min: 1, max: 5, interpretation: {} } },
      ];
      const result = await generateScenarioQuestion(dimensionSet, [], [], null, null, null, null, fake);

      assert.ok(result.nextQuestion);
      assert.strictEqual(result.nextQuestion.title, 'Pick one');
      assert.strictEqual(result.nextQuestion.options.length, 2);
      assert.ok(typeof result.nextQuestion.options[0].dimensionScores === 'object');
      assert.ok(typeof result.nextQuestion.options[1].dimensionScores === 'object');
      assert.strictEqual(result.dimensionSet.length, 1);
      assert.strictEqual(result.dimensionSet[0].dimensionId, 'x');
    });

    it('returns question when step 1 returns one scenario and step 3 returns question with optionScores', async () => {
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
      const step3Question = {
        title: 'Team?',
        description: 'Your team has to present next week. You can prepare solo or with others.',
        type: 'single_choice',
        options: [
          { text: 'Solo', value: 'solo', dimensionScores: { collab: 1 } },
          { text: 'Team', value: 'team', dimensionScores: { collab: 5 } },
        ],
      };
      const responses = threeStepResponses(step1PlainText, 'How they work with others.', 'PASS', step3Question);
      const fake = createFakeOllama(responses);

      const result = await generateScenarioQuestion(dimensionSetWithScale, [], [], null, null, null, null, fake);

      assert.ok(result.nextQuestion);
      assert.strictEqual(result.nextQuestion.options[0].dimensionScores.collab, 1);
      assert.strictEqual(result.nextQuestion.options[1].dimensionScores.collab, 5);
    });

    it('returns null when judge always returns FAIL (critique rejects all attempts)', async () => {
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
      const responses = [
        step1PlainText,
        'Collaboration and teamwork.',
        'FAIL',
        step1PlainText,
        'How they work in a team.',
        'FAIL',
        step1PlainText,
        'Whether they prefer solo or group work.',
        'FAIL',
      ];
      const fake = createFakeOllama(responses);

      const result = await generateScenarioQuestion(dimensionSetWithScale, [], [], null, null, null, null, fake);

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

  describe('three-step flow with non-1-5 score scale', () => {
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
      const step1Plain = 'TITLE:\nImpact?\n\nSITUATION:\nYou can help one person a lot or many a little.\n\nOPTIONS:\n- One\n- Many';
      const step3Question = {
        title: 'Impact?',
        description: 'You can help one person a lot or many a little.',
        type: 'single_choice',
        options: [
          { text: 'One', value: 'one', dimensionScores: { impact: 9 } },
          { text: 'Many', value: 'many', dimensionScores: { impact: 3 } },
        ],
      };
      const responses = threeStepResponses(step1Plain, 'Whether they prefer broad or deep impact.', 'PASS', step3Question);
      const fake = createFakeOllama(responses);

      const result = await generateScenarioQuestion(dimensionSetWithScale, [], [], null, null, null, null, fake);

      assert.ok(result.nextQuestion);
      assert.strictEqual(result.nextQuestion.options[0].dimensionScores.impact, 9);
      assert.strictEqual(result.nextQuestion.options[1].dimensionScores.impact, 3);
    });
  });

  describe('getScenarioOnlySystemPrompt', () => {
    it('includes step1 content and plain-text format', () => {
      const prompt = getScenarioOnlySystemPrompt();
      assert.ok(
        prompt.includes('THE DIMENSION YOU ARE MEASURING') || prompt.includes('TITLE') || prompt.includes('SITUATION') || prompt.includes('OPTIONS'),
        'step-1 system prompt should include dimension or output headings'
      );
      assert.ok(prompt.includes('TITLE') || prompt.includes('plain text'), 'step-1 should request plain text with headings');
    });
  });

  describe('buildScenarioStep1UserPrompt', () => {
    it('asks for one scenario and includes asked titles and answers', () => {
      const prompt = buildScenarioStep1UserPrompt(['Q1', 'Q2'], [{ value: 'a' }, { value: 'b' }]);
      assert.ok(prompt.includes('one scenario') || prompt.includes('TITLE'), 'should request one scenario');
      assert.ok(prompt.includes('Q1') && prompt.includes('Q2'), 'should list asked titles');
      assert.ok(prompt.includes('a') && prompt.includes('b'), 'should include answer values');
    });

    it('with empty askedTitles and answers still requests one scenario', () => {
      const prompt = buildScenarioStep1UserPrompt([], []);
      assert.ok(prompt.includes('one scenario') || prompt.includes('Generate one'));
      assert.ok(prompt.includes('TITLE') || prompt.includes('plain text'));
    });

    it('includes dimension name and id when primaryDimension is provided', () => {
      const primary = { name: 'Mastery and growth', dimensionId: 'mastery_growth' };
      const prompt = buildScenarioStep1UserPrompt([], [], primary);
      assert.ok(prompt.includes('Mastery and growth'), 'user prompt must state the dimension name');
      assert.ok(prompt.includes('mastery_growth'), 'user prompt must state the dimension ID');
    });
  });

  describe('parseStep1PlainText', () => {
    it('parses TITLE, SITUATION, OPTIONS into one scenario', () => {
      const raw = `TITLE:\nPick one\n\nSITUATION:\nA short scenario.\n\nOPTIONS:\n- Option A\n- Option B`;
      const parsed = parseStep1PlainText(raw);
      assert.ok(parsed);
      assert.strictEqual(parsed.title, 'Pick one');
      assert.strictEqual(parsed.situation, 'A short scenario.');
      assert.strictEqual(parsed.options.length, 2);
      assert.strictEqual(parsed.options[0], 'Option A');
      assert.strictEqual(parsed.options[1], 'Option B');
    });

    it('returns null when OPTIONS is missing', () => {
      const raw = `TITLE:\nX\n\nSITUATION:\nY`;
      assert.strictEqual(parseStep1PlainText(raw), null);
    });
  });

  describe('runCritiquePass', () => {
    it('returns true when judge returns PASS', async () => {
      const plainScenario = { title: 'T', situation: 'S', options: ['A', 'B'] };
      const primary = { name: 'Recognition' };
      const fake = createFakeOllama(['Something about credit.', 'PASS']);
      const passed = await runCritiquePass(plainScenario, primary, fake);
      assert.strictEqual(passed, true);
    });

    it('returns false when judge returns FAIL', async () => {
      const plainScenario = { title: 'T', situation: 'S', options: ['A', 'B'] };
      const primary = { name: 'Recognition' };
      const fake = createFakeOllama(['Recognition and visibility.', 'FAIL']);
      const passed = await runCritiquePass(plainScenario, primary, fake);
      assert.strictEqual(passed, false);
    });
  });

  describe('getScenarioStep1SystemPromptWithDimension', () => {
    it('includes the dimension name and id so the LLM knows what trait/value to design for', () => {
      const primary = {
        name: 'Mastery and growth',
        dimensionId: 'mastery_growth',
        description: 'Wants to learn and improve.',
        how_measured_or_observed: 'Choices that favor challenge and learning.',
        score_scale: { min: 1, max: 5, interpretation: { low: 'stable', medium: 'mixed', high: 'growth' } },
      };
      const systemPrompt = getScenarioStep1SystemPromptWithDimension(primary);
      assert.ok(systemPrompt.includes('Mastery and growth'), 'step1 system prompt must include dimension name');
      assert.ok(systemPrompt.includes('mastery_growth') || systemPrompt.includes('Mastery and growth'), 'step1 must identify the dimension');
    });

  });

  describe('getScenarioStep3SystemPrompt', () => {
    it('includes the dimension name and id so the LLM knows what trait/value is being scored', () => {
      const primary = { name: 'Mastery and growth', dimensionId: 'mastery_growth' };
      const systemPrompt = getScenarioStep3SystemPrompt(primary);
      assert.ok(systemPrompt.includes('Mastery and growth'), 'step3 system prompt must include dimension name');
      assert.ok(systemPrompt.includes('mastery_growth'), 'step3 system prompt must include dimension ID');
    });
  });

});
