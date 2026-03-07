/**
 * Uses Ollama to assess answers and generate the next interview question
 * for Built for Tomorrow. Expects Ollama to return JSON.
 * System prompt is loaded from conf/ via config/llm.js when set.
 * Pre-survey profile (dominant clusters, demographics) is used to tailor tone and style.
 */

const path = require('path');
const fs = require('fs');
const ollamaClient = require('./ollamaClient');
const assessmentModel = require('../data/assessmentModel');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PERSONALITY_CLUSTERS_PATH = path.join(PROJECT_ROOT, 'src', 'data', 'personality_clusters.json');

function resolveScenarioStepPath(envKey, examplePath) {
  const raw = process.env[envKey];
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    console.error(`[config] ${envKey} is required. Set it in .env (see .env.example). Example: ${examplePath}`);
    process.exit(1);
  }
  const resolved = path.isAbsolute(raw) ? raw : path.join(PROJECT_ROOT, raw);
  if (!fs.existsSync(resolved)) {
    console.error(`[config] ${envKey} does not exist: ${resolved}`);
    process.exit(1);
  }
  return resolved;
}
const SCENARIO_STEP1_INSTRUCTIONS_PATH = resolveScenarioStepPath('BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE', 'conf/scenario_step1.txt');
const SCENARIO_STEP2_CRITIQUE_PATH = path.join(PROJECT_ROOT, 'conf', 'scenario_step2_critique.txt');
const SCENARIO_STEP2_JUDGE_PATH = path.join(PROJECT_ROOT, 'conf', 'scenario_step2_judge.txt');
const SCENARIO_STEP3_INSTRUCTIONS_PATH = resolveScenarioStepPath('BFT_SCENARIO_STEP3_INSTRUCTIONS_FILE', 'conf/scenario_step3.txt');

let personalityClustersCache = null;

function getPersonalityClusters() {
  if (personalityClustersCache) return personalityClustersCache;
  try {
    const raw = fs.readFileSync(PERSONALITY_CLUSTERS_PATH, 'utf8');
    const data = JSON.parse(raw);
    personalityClustersCache = (data.clusters || []).map((c) => ({
      name: c.name,
      short: c.short || c.name,
      avoid: c.avoid ?? null,
    }));
    return personalityClustersCache;
  } catch {
    return [];
  }
}

/** One-line style synthesis: avoid contradictions (e.g. neutral "no metaphor" vs gaming "game-like"). */
function synthesizeStyleLine(dominantNames, byShort) {
  if (!Array.isArray(dominantNames) || dominantNames.length === 0) return '';
  const shorts = dominantNames.map((n) => byShort.get(n)).filter(Boolean);
  if (shorts.length === 0) return '';
  const hasNeutral = dominantNames.includes('neutral');
  const others = dominantNames.filter((n) => n !== 'neutral');
  if (hasNeutral && others.length > 0) {
    const otherPhrases = others.map((n) => byShort.get(n)).filter(Boolean);
    return `Clear structure and straightforward tasks; add ${otherPhrases.join(' or ')} where it fits.`;
  }
  if (shorts.length === 1) return `Use ${shorts[0]}.`;
  return `Blend: ${shorts.join('; ')}.`;
}

/** One-line voice synthesis so the model has a single north star for how to write. */
function buildVoiceLine(preSurveyProfile, byShort) {
  const parts = [];
  const demographics = preSurveyProfile.demographics;
  const ageGroup = demographics?.ageGroup;
  if (ageGroup) {
    const reader = ageGroup.includes('Middle school') ? 'a middle-school reader' : ageGroup.includes('High school') ? 'a high-school reader' : ageGroup.includes('College') ? 'a college-age reader' : 'this reader';
    parts.push(`Write for ${reader}`);
  }
  const toneInstruction = preSurveyProfile.toneInstruction;
  const secondaryTone = preSurveyProfile.secondaryTone;
  if (toneInstruction && typeof toneInstruction === 'string') {
    const firstClause = toneInstruction.split(/[.;]/)[0].trim().toLowerCase();
    if (firstClause) parts.push(firstClause);
  } else if (secondaryTone && secondaryTone !== 'neutral') {
    const tonePhrase = (byShort.get(secondaryTone) || secondaryTone).toLowerCase();
    if (tonePhrase) parts.push(tonePhrase);
  }
  const dominant = preSurveyProfile.dominant;
  const secondary = preSurveyProfile.secondary;
  const stylePhrases = [];
  if (Array.isArray(dominant) && dominant.length > 0) {
    dominant.forEach((n) => { const s = byShort.get(n); if (s) stylePhrases.push(s); });
  }
  if (Array.isArray(secondary) && secondary.length > 0) {
    secondary.forEach((n) => { const s = byShort.get(n); if (s && !stylePhrases.includes(s)) stylePhrases.push(s); });
  }
  if (stylePhrases.length > 0) {
    const hasNeutral = Array.isArray(dominant) && dominant.includes('neutral');
    const secondaryShorts = Array.isArray(secondary) ? secondary.map((n) => byShort.get(n)).filter(Boolean) : [];
    const blendPhrases = hasNeutral && secondaryShorts.length > 0 ? secondaryShorts.slice(0, 2) : stylePhrases.slice(0, 2);
    const styleBlurb = blendPhrases.length === 1
      ? blendPhrases[0]
      : `clear and relatable, with room for ${blendPhrases.join(' or ')} when it fits`;
    parts.push(parts.length > 0 ? `keep scenarios ${styleBlurb}` : `scenarios should be ${styleBlurb}`);
  }
  if (parts.length === 0) return '';
  const voiceSentence = parts.join('; ') + '.';
  return voiceSentence.charAt(0).toUpperCase() + voiceSentence.slice(1);
}

/**
 * Build a short, non-contradictory tailoring block for the system prompt.
 * Uses AUDIENCE, STYLE (with secondary blend), TONE, COMPLEXITY.
 */
function buildTailoringBlock(preSurveyProfile) {
  if (!preSurveyProfile || typeof preSurveyProfile !== 'object') return '';
  const clusters = getPersonalityClusters();
  const byShort = new Map(clusters.map((c) => [c.name, c.short]));

  const lines = [];

  // AUDIENCE
  const demographics = preSurveyProfile.demographics;
  if (demographics && (demographics.ageGroup || demographics.gender)) {
    const audience = [demographics.ageGroup, demographics.gender].filter(Boolean).join(', ');
    if (audience) lines.push(`AUDIENCE: ${audience}.`);
  }

  // STYLE: dominant and secondary blend
  const dominant = preSurveyProfile.dominant;
  const secondary = preSurveyProfile.secondary;
  if (Array.isArray(secondary) && secondary.length > 0) {
    const primaryShorts = (Array.isArray(dominant) ? dominant : [])
      .map((n) => byShort.get(n))
      .filter(Boolean);
    const secondaryShorts = secondary.map((n) => byShort.get(n)).filter(Boolean);
    const parts = [];
    if (primaryShorts.length > 0) parts.push(`Primarily ${primaryShorts.join('; ')}.`);
    if (secondaryShorts.length > 0) parts.push(`Also ${secondaryShorts.join('; ')}. Blend both when possible.`);
    if (parts.length > 0) lines.push(`STYLE: ${parts.join(' ')}`);
  } else {
    const styleLine = synthesizeStyleLine(Array.isArray(dominant) ? dominant : [], byShort);
    if (styleLine) lines.push(`STYLE: ${styleLine}`);
  }

  // TONE: prefer toneInstruction (from Q5), else secondaryTone → cluster short
  const toneInstruction = preSurveyProfile.toneInstruction;
  if (toneInstruction && typeof toneInstruction === 'string' && toneInstruction.trim()) {
    lines.push(`TONE: ${toneInstruction.trim()}`);
  } else {
    const secondaryTone = preSurveyProfile.secondaryTone;
    if (secondaryTone && secondaryTone !== 'neutral') {
      const toneShort = byShort.get(secondaryTone);
      if (toneShort) lines.push(`TONE: ${toneShort}.`);
    }
  }

  // COMPLEXITY: from age group (Q2)
  const complexityInstruction = preSurveyProfile.complexityInstruction;
  if (complexityInstruction && typeof complexityInstruction === 'string' && complexityInstruction.trim()) {
    lines.push(`COMPLEXITY: ${complexityInstruction.trim()}`);
  }

  // VOICE: one-line north star so the model knows how to sound (audience + tone + style)
  const voiceLine = buildVoiceLine(preSurveyProfile, byShort);
  if (voiceLine) lines.push(`VOICE: ${voiceLine}`);

  if (lines.length === 0) return '';
  lines.push('Match this audience and style; avoid formal or corporate wording.');
  return '\n\n---\nTailoring for this person:\n' + lines.join('\n') + '\n';
}

/**
 * Parse next question and assessment from Ollama response. Tolerates markdown code block.
 */
function parseResponse(content) {
  let raw = content.trim();
  const codeMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) raw = codeMatch[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Parse Step 1 plain-text response into one scenario. Expects TITLE:, SITUATION:, OPTIONS: headings.
 * @param {string} content - Raw LLM response (plain text)
 * @returns {{ title: string, situation: string, options: string[] } | null}
 */
function parseStep1PlainText(content) {
  if (!content || typeof content !== 'string') return null;
  const raw = content.trim();
  const titleMatch = raw.match(/\bTITLE:\s*([\s\S]*?)(?=\n\s*SITUATION:|\n\s*OPTIONS:|$)/i);
  const situationMatch = raw.match(/\bSITUATION:\s*([\s\S]*?)(?=\n\s*OPTIONS:|$)/i);
  const optionsBlock = raw.match(/\bOPTIONS:\s*([\s\S]*?)$/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const situation = situationMatch ? situationMatch[1].trim() : '';
  if (!title && !situation) return null;
  let options = [];
  if (optionsBlock && optionsBlock[1]) {
    const lines = optionsBlock[1].trim().split(/\n/);
    options = lines
      .map((l) => l.replace(/^\s*[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
      .filter((l) => l.length > 0);
  }
  if (options.length === 0) return null;
  return { title, situation, options };
}

const VALID_TYPES = new Set(['single_choice', 'multi_choice', 'rank']);

/**
 * Validate nextQuestion object. idOptional: when true, id is not required (assigned in code).
 * scoringOptions: { expectedDimensionIds: string[], scoreMin: number, scoreMax: number, allowPartialDimensionScores?: boolean }
 * When allowPartialDimensionScores is true, do not require all expectedDimensionIds to be present; only validate that every key present is in expectedIds and value is 1-5.
 */
function validateNextQuestionObject(q, idOptional = false, scoringOptions = null) {
  const errors = [];
  if (q == null || typeof q !== 'object') {
    return { valid: false, errors: ['nextQuestion must be a non-null object.'] };
  }
  if (idOptional) {
    if (q.id != null && (typeof q.id !== 'string' || !/^[a-zA-Z0-9_]+$/.test(q.id))) {
      errors.push('"nextQuestion.id" if present must be a string with only letters, numbers, underscores.');
    }
  } else if (typeof q.id !== 'string' || !/^[a-zA-Z0-9_]+$/.test(q.id)) {
    errors.push('"nextQuestion.id" must be a string with only letters, numbers, underscores (e.g. q_1).');
  }
  if (typeof q.title !== 'string' || q.title.trim() === '') {
    errors.push('"nextQuestion.title" must be a non-empty string.');
  }
  const requireDescription = scoringOptions != null;
  if (requireDescription) {
    if (typeof q.description !== 'string' || q.description.trim() === '') {
      errors.push('"nextQuestion.description" is required and must be a non-empty string (the 2–3 sentence scenario the person reads before the options).');
    }
  } else if (q.description != null && typeof q.description !== 'string') {
    errors.push('"nextQuestion.description" must be a string or omitted.');
  }
  if (!VALID_TYPES.has(q.type)) {
    errors.push(`"nextQuestion.type" must be one of "single_choice", "multi_choice", or "rank". Got: ${JSON.stringify(q.type)}.`);
  }
  const expectedIds = scoringOptions && Array.isArray(scoringOptions.expectedDimensionIds) && scoringOptions.expectedDimensionIds.length > 0
    ? scoringOptions.expectedDimensionIds
    : null;
  const allowPartial = scoringOptions && scoringOptions.allowPartialDimensionScores === true;
  const scoreMin = scoringOptions && typeof scoringOptions.scoreMin === 'number' ? scoringOptions.scoreMin : 1;
  const scoreMax = scoringOptions && typeof scoringOptions.scoreMax === 'number' ? scoringOptions.scoreMax : 5;

  if (!Array.isArray(q.options) || q.options.length === 0) {
    errors.push('"nextQuestion.options" must be a non-empty array of { "text": string, "value": string }.');
  } else {
    const seenValues = new Set();
    q.options.forEach((opt, i) => {
      if (opt == null || typeof opt !== 'object') {
        errors.push(`"nextQuestion.options[${i}]" must be an object with "text" and "value".`);
        return;
      }
      if (typeof opt.text !== 'string' || opt.text.trim() === '') {
        errors.push(`"nextQuestion.options[${i}].text" must be a non-empty string.`);
      }
      if (typeof opt.value !== 'string' || opt.value === '') {
        errors.push(`"nextQuestion.options[${i}].value" must be a non-empty string.`);
      } else {
        if (seenValues.has(opt.value)) {
          errors.push(`"nextQuestion.options": duplicate option value "${opt.value}". Each value must be unique.`);
        }
        seenValues.add(opt.value);
      }
      if (expectedIds) {
        if (opt.dimensionScores == null || typeof opt.dimensionScores !== 'object') {
          if (!allowPartial) {
            errors.push(`"nextQuestion.options[${i}].dimensionScores" is required and must be an object with keys: ${expectedIds.join(', ')}.`);
          }
        } else {
          const keys = Object.keys(opt.dimensionScores);
          const extra = keys.filter((k) => !expectedIds.includes(k));
          if (extra.length > 0) {
            errors.push(`"nextQuestion.options[${i}].dimensionScores" has unexpected keys: ${extra.join(', ')}. Use only: ${expectedIds.join(', ')}.`);
          }
          if (!allowPartial) {
            const missing = expectedIds.filter((id) => !keys.includes(id));
            if (missing.length > 0) {
              errors.push(`"nextQuestion.options[${i}].dimensionScores" missing keys: ${missing.join(', ')}.`);
            }
          }
          keys.forEach((dimId) => {
            const v = opt.dimensionScores[dimId];
            if (v === undefined || v === null) return;
            const n = Number(v);
            if (!Number.isInteger(n) || n < scoreMin || n > scoreMax) {
              errors.push(`"nextQuestion.options[${i}].dimensionScores.${dimId}" must be an integer from ${scoreMin} to ${scoreMax}. Got: ${v}.`);
            }
          });
        }
      }
    });
  }
  if (q.type !== 'rank' && q.maxSelections != null && (typeof q.maxSelections !== 'number' || q.maxSelections < 1 || !Number.isInteger(q.maxSelections))) {
    errors.push('"nextQuestion.maxSelections" must be a positive integer or omitted (omit for rank).');
  }
  return { valid: errors.length === 0, errors };
}

function getScenarioStep1Instructions() {
  try {
    return fs.readFileSync(SCENARIO_STEP1_INSTRUCTIONS_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

function getScenarioStep3Instructions() {
  try {
    return fs.readFileSync(SCENARIO_STEP3_INSTRUCTIONS_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Build the "THE DIMENSION YOU ARE MEASURING" block so the LLM always knows which trait/value to design for. */
function buildDimensionBlockForStep1(primaryDimension) {
  if (!primaryDimension || !primaryDimension.name) return '';
  const scale = primaryDimension.score_scale && typeof primaryDimension.score_scale === 'object' ? primaryDimension.score_scale : {};
  const interp = scale.interpretation || {};
  const lines = [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'THE DIMENSION YOU ARE MEASURING',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `Name: ${primaryDimension.name}`,
    '',
    `Description: ${primaryDimension.description || ''}`,
    '',
    `How it manifests behaviorally: ${primaryDimension.how_measured_or_observed || ''}`,
    '',
    'Scoring scale:',
    `- Low (1-2): ${interp.low || 'low'}`,
    `- Medium (3): ${interp.medium || 'medium'}`,
    `- High (4-5): ${interp.high || 'high'}`,
    '',
  ];
  if (primaryDimension.scenario_constraint && primaryDimension.scenario_constraint.trim()) {
    lines.push(primaryDimension.scenario_constraint.trim(), '');
  }
  return lines.join('\n');
}

/**
 * Build Step 1 system prompt: load step1 template and replace dimension placeholders.
 * If the template has no dimension placeholders, appends the dimension block so the LLM always sees which trait/value is being assessed.
 * @param {object} primaryDimension - one enriched dimension (name, description, how_measured_or_observed, score_scale)
 * @returns {string}
 */
function getScenarioStep1SystemPromptWithDimension(primaryDimension) {
  const rawStep1 = getScenarioStep1Instructions();
  if (!rawStep1) return 'Generate one scenario. Output plain text with TITLE:, SITUATION:, OPTIONS: headings.';
  let step1 = rawStep1;
  const scale = primaryDimension && primaryDimension.score_scale && typeof primaryDimension.score_scale === 'object' ? primaryDimension.score_scale : {};
  const interp = scale.interpretation || {};
  const replacements = {
    '{{DIMENSION_NAME}}': (primaryDimension && primaryDimension.name) || 'the dimension',
    '{{DIMENSION_DESCRIPTION}}': (primaryDimension && primaryDimension.description) || '',
    '{{HOW_MEASURED_OR_OBSERVED}}': (primaryDimension && primaryDimension.how_measured_or_observed) || '',
    '{{LOW_INTERPRETATION}}': interp.low || 'low',
    '{{MEDIUM_INTERPRETATION}}': interp.medium || 'medium',
    '{{HIGH_INTERPRETATION}}': interp.high || 'high',
    '{{DIMENSION_CONSTRAINT}}': (primaryDimension && primaryDimension.scenario_constraint) || '',
  };
  Object.keys(replacements).forEach((key) => {
    step1 = step1.split(key).join(replacements[key]);
  });
  if (primaryDimension && !rawStep1.includes('{{DIMENSION_NAME}}')) {
    step1 = step1 + buildDimensionBlockForStep1(primaryDimension);
  }
  return step1;
}

function getScenarioOnlySystemPrompt() {
  const step1 = getScenarioStep1Instructions();
  return step1 || 'Design one scenario with one clear dilemma and options as direct responses. Output TITLE:, SITUATION:, OPTIONS: as plain text.';
}

/**
 * Build Step 3 (format and score) system prompt. Prepends the dimension and score scale so the LLM assigns dimensionScores correctly.
 * @param {object} [primaryDimension] - enriched primary dimension (name, dimensionId, score_scale)
 * @returns {string}
 */
function getScenarioStep3SystemPrompt(primaryDimension) {
  let step3 = getScenarioStep3Instructions();
  if (!step3) step3 = 'Convert the scenario to JSON with title, description, type, options (each with text, value, dimensionScores). Assign dimensionScores 1-5 per option for the primary dimension.';
  if (primaryDimension && primaryDimension.name && primaryDimension.dimensionId) {
    const scale = primaryDimension.score_scale && typeof primaryDimension.score_scale === 'object' ? primaryDimension.score_scale : {};
    const interp = scale.interpretation || {};
    const header = `The dimension you are scoring for: ${primaryDimension.name} (dimension ID: ${primaryDimension.dimensionId}). Score scale: low (1-2) = ${interp.low || 'low'}; medium (3) = ${interp.medium || 'medium'}; high (4-5) = ${interp.high || 'high'}.\n\n`;
    step3 = header + step3;
  }
  return step3;
}

function buildScenarioStep1UserPrompt(askedTitles, answers, primaryDimension) {
  const lines = [];
  if (primaryDimension && primaryDimension.name && primaryDimension.dimensionId) {
    lines.push(`Design one scenario that probes this dimension: ${primaryDimension.name} (ID: ${primaryDimension.dimensionId}). See the system prompt for description and scoring scale.`);
    lines.push('');
  }
  lines.push('Generate one scenario as specified. Output plain text only with TITLE:, SITUATION:, and OPTIONS: headings. No JSON.');
  if (askedTitles.length > 0) {
    lines.push('');
    lines.push('Do not repeat or rephrase these already-asked questions:');
    askedTitles.forEach((t) => lines.push(`- ${t}`));
  }
  lines.push('');
  lines.push('Answers so far (for context). Each line: question asked → option value(s) chosen:');
  (answers || []).forEach((a, i) => {
    const title = (askedTitles && askedTitles[i]) ? askedTitles[i] : (a.questionId || a.questionTitle || `Q${i + 1}`);
    const v = a.value ?? a.selected ?? a.answer ?? a.text ?? JSON.stringify(a);
    lines.push(`- "${title}" → ${Array.isArray(v) ? JSON.stringify(v) : v}`);
  });
  lines.push('');
  lines.push('Reply with your scenario using exactly the headings TITLE:, SITUATION:, and OPTIONS:.');
  return lines.join('\n');
}

/**
 * Build Step 3 user prompt: one plain-text scenario to convert to JSON with dimensionScores.
 * @param {{ title: string, situation: string, options: string[] }} plainScenario - parsed Step 1 output
 * @param {object} primaryDimension - enriched primary dimension
 * @returns {string}
 */
function buildStep3FormatAndScoreUserPrompt(plainScenario, primaryDimension) {
  const lines = [
    'Convert the scenario below into the required JSON format and assign dimensionScores for each option.',
    `Primary dimension: ${primaryDimension.dimensionId} (${primaryDimension.name}).`,
    '',
    'SCENARIO TO CONVERT:',
    'TITLE:',
    (plainScenario.title || '').trim() || '(none)',
    '',
    'SITUATION:',
    (plainScenario.situation || '').trim() || '(none)',
    '',
    'OPTIONS:',
    ...(plainScenario.options || []).map((o) => `- ${o}`),
    '',
    'Reply with exactly one JSON object (title, description, type, options with text, value, dimensionScores). No markdown.',
  ];
  return lines.join('\n');
}

function getChatClient(client) {
  return client || ollamaClient;
}

const CRITIQUE_PROMPT_FALLBACK = 'Read this scenario. If a perceptive 16-year-old took this test, what would they think it is measuring? Reply in one sentence.';

function getScenarioStep2CritiquePrompt() {
  try {
    if (fs.existsSync(SCENARIO_STEP2_CRITIQUE_PATH)) {
      return fs.readFileSync(SCENARIO_STEP2_CRITIQUE_PATH, 'utf8').trim();
    }
  } catch (_) {}
  return CRITIQUE_PROMPT_FALLBACK;
}

const JUDGE_PROMPT_FALLBACK = 'A test-taker said: "{{CRITIQUE_SENTENCE}}". The dimension we are measuring is {{DIMENSION_NAME}}. Does that answer show they would identify what is being measured? Reply only PASS or FAIL.';

function getScenarioStep2JudgePromptTemplate() {
  try {
    if (fs.existsSync(SCENARIO_STEP2_JUDGE_PATH)) {
      return fs.readFileSync(SCENARIO_STEP2_JUDGE_PATH, 'utf8').trim();
    }
  } catch (_) {}
  return JUDGE_PROMPT_FALLBACK;
}

function buildJudgePrompt(critiqueSentence, dimensionName) {
  const template = getScenarioStep2JudgePromptTemplate();
  return template
    .split('{{CRITIQUE_SENTENCE}}').join(critiqueSentence)
    .split('{{DIMENSION_NAME}}').join(dimensionName);
}

/**
 * Step 2: critique then judge. Two LLM calls. Returns true if the scenario does not telegraph the dimension (pass), false to reject.
 * @param {{ title: string, situation: string, options: string[] }} plainScenario
 * @param {object} primaryDimension - enriched primary dimension (name)
 * @param {{ chat: function } | null} [client]
 * @returns {Promise<boolean>}
 */
async function runCritiquePass(plainScenario, primaryDimension, client = null) {
  const chat = getChatClient(client);
  const scenarioText = [
    `TITLE: ${(plainScenario.title || '').trim()}`,
    `SITUATION: ${(plainScenario.situation || '').trim()}`,
    'OPTIONS:',
    ...(plainScenario.options || []).map((o) => `- ${o}`),
  ].join('\n');

  const critiquePrompt = getScenarioStep2CritiquePrompt();
  const critiqueContent = (await chat.chat([
    { role: 'user', content: `${critiquePrompt}\n\n${scenarioText}` },
  ])).content;
  const critiqueSentence = (critiqueContent || '').trim().replace(/\n.*/s, '').trim();
  if (!critiqueSentence) return false;

  const judgeContent = (await chat.chat([
    { role: 'user', content: buildJudgePrompt(critiqueSentence, primaryDimension.name || 'the dimension') },
  ])).content;
  const firstWord = (judgeContent || '').trim().toUpperCase().split(/\s+/)[0] || '';
  if (firstWord === 'PASS') return true;
  if (firstWord === 'FAIL') return false;
  return false;
}

/**
 * Step 3: format one plain-text scenario to JSON and assign dimensionScores. One LLM call.
 * @param {{ title: string, situation: string, options: string[] }} plainScenario
 * @param {object} primaryDimension - enriched primary dimension
 * @param {{ chat: function } | null} [client]
 * @returns {Promise<{ question: object, dimensionSet: Array<{ dimensionType: string, dimensionId: string }> } | null>}
 */
async function formatAndScoreScenario(plainScenario, primaryDimension, client = null) {
  const chat = getChatClient(client);
  const systemContent = getScenarioStep3SystemPrompt(primaryDimension);
  const userContent = buildStep3FormatAndScoreUserPrompt(plainScenario, primaryDimension);
  const content = (await chat.chat([
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ])).content;
  const parsed = parseResponse(content);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.options) || parsed.options.length === 0) {
    console.warn('[LLM] Step 3 invalid or missing JSON');
    return null;
  }
  const primaryId = primaryDimension.dimensionId;
  const scoreMin = primaryDimension.score_scale && primaryDimension.score_scale.min != null ? primaryDimension.score_scale.min : 1;
  const scoreMax = primaryDimension.score_scale && primaryDimension.score_scale.max != null ? primaryDimension.score_scale.max : 5;
  const question = {
    title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
    description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
    type: VALID_TYPES.has(parsed.type) ? parsed.type : 'single_choice',
    options: parsed.options.map((opt) => ({
      text: (opt && opt.text) != null ? String(opt.text).trim() : '',
      value: (opt && opt.value) != null ? String(opt.value).trim() : '',
      dimensionScores: (opt && opt.dimensionScores && typeof opt.dimensionScores === 'object') ? opt.dimensionScores : {},
    })),
  };
  const allDimensionIds = new Set([primaryId]);
  for (const opt of question.options) {
    Object.keys(opt.dimensionScores || {}).forEach((id) => allDimensionIds.add(id));
  }
  for (const opt of question.options) {
    const ds = opt.dimensionScores[primaryId];
    if (ds === undefined || ds === null) {
      console.warn('[LLM] Step 3 option missing primary dimension', primaryId);
      return null;
    }
    const n = Number(ds);
    if (!Number.isInteger(n) || n < scoreMin || n > scoreMax) {
      console.warn('[LLM] Step 3 primary score out of range:', ds);
      return null;
    }
  }
  const dimensionSet = [{ dimensionType: primaryDimension.dimensionType, dimensionId: primaryDimension.dimensionId }];
  for (const dimId of allDimensionIds) {
    if (dimId === primaryId) continue;
    const asTrait = assessmentModel.getDimension('trait', dimId);
    const asValue = assessmentModel.getDimension('value', dimId);
    if (asTrait) dimensionSet.push({ dimensionType: 'trait', dimensionId: dimId });
    else if (asValue) dimensionSet.push({ dimensionType: 'value', dimensionId: dimId });
  }
  return { question, dimensionSet };
}

const MAX_CRITIQUE_ATTEMPTS = 3;

/**
 * Step 1 + Step 2 loop: generate one plain-text scenario, then critique and judge. Up to MAX_CRITIQUE_ATTEMPTS attempts. Returns the first scenario that passes critique, or null.
 * @returns {Promise<{ plainScenario: { title: string, situation: string, options: string[] } } | null>}
 */
async function generateOneScenarioPassingCritique(primaryDimension, askedTitles, answers, preSurveyProfile, client = null) {
  const chat = getChatClient(client);
  const tailoring = buildTailoringBlock(preSurveyProfile);
  const systemContent =
    getScenarioStep1SystemPromptWithDimension(primaryDimension)
    + (tailoring ? '\n\n' + tailoring : '');
  const userContent = buildScenarioStep1UserPrompt(askedTitles || [], answers, primaryDimension);

  for (let attempt = 0; attempt < MAX_CRITIQUE_ATTEMPTS; attempt++) {
    const content = (await chat.chat([
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ])).content;
    const plainScenario = parseStep1PlainText(content);
    if (!plainScenario) {
      console.warn('[LLM] Step 1 parse failed on attempt', attempt + 1);
      continue;
    }
    const passed = await runCritiquePass(plainScenario, primaryDimension, client);
    if (passed) return { plainScenario };
    console.warn('[LLM] Step 2 critique rejected scenario on attempt', attempt + 1);
  }
  return null;
}

async function generateScenarioQuestionTwoStep(dimensionSet, askedTitles, answers, preSurveyProfile, preferredResponseType, batchTheme, dilemmaAnchor, client = null) {
  if (!dimensionSet || dimensionSet.length === 0) return { assessmentSummary: null, nextQuestion: null };
  const primary = dimensionSet[0];

  const critiqueResult = await generateOneScenarioPassingCritique(primary, askedTitles || [], answers, preSurveyProfile, client);
  if (!critiqueResult || !critiqueResult.plainScenario) return { assessmentSummary: null, nextQuestion: null };

  const step3Result = await formatAndScoreScenario(critiqueResult.plainScenario, primary, client);
  if (!step3Result || !step3Result.question) return { assessmentSummary: null, nextQuestion: null };

  const question = step3Result.question;
  const dimensionSetForValidation = step3Result.dimensionSet || [primary];
  const dimensionsWithScale = dimensionSetForValidation
    .map((d) => assessmentModel.getDimension(d.dimensionType, d.dimensionId))
    .filter(Boolean)
    .filter((d) => d.score_scale && typeof d.score_scale === 'object');
  const scoringOptions =
    dimensionsWithScale.length > 0
      ? {
          expectedDimensionIds: dimensionsWithScale.map((d) => d.id),
          scoreMin: dimensionsWithScale[0].score_scale.min != null ? dimensionsWithScale[0].score_scale.min : 1,
          scoreMax: dimensionsWithScale[0].score_scale.max != null ? dimensionsWithScale[0].score_scale.max : 5,
          allowPartialDimensionScores: true,
        }
      : null;
  const finalValidation = validateNextQuestionObject(question, true, scoringOptions);
  if (!finalValidation.valid) {
    console.warn('[LLM] Step 3 question validation failed:', finalValidation.errors);
    return { assessmentSummary: null, nextQuestion: null };
  }
  return { assessmentSummary: null, nextQuestion: question, dimensionSet: step3Result.dimensionSet };
}

/**
 * Generate one scenario-based question that probes the given dimension set.
 * Three-step flow: (1) creative plain-text scenario, (2) critique then judge, (3) format to JSON and assign dimensionScores.
 * @param {Array<object>} dimensionSet - [{ dimensionType, dimensionId, name, question_hints, how_measured_or_observed, score_scale? }]
 * @param {string[]} askedQuestionTitles - Titles of questions already asked (for deduplication)
 * @param {Array<object>} answers - Previous answers
 * @param {object} [preSurveyProfile] - Pre-survey profile for tailoring
 * @param {string} [preferredResponseType] - single_choice, multi_choice, or rank
 * @param {string} [batchTheme] - Optional batch theme for step 1 (e.g. "Team, belonging, and ownership")
 * @param {string} [dilemmaAnchor] - Optional situation-only hint for step 1 (no trait words)
 * @param {{ chat: function } | null} [client] - Optional chat client for tests (fake Ollama). If null, uses ollamaClient.
 * @returns {Promise<{ assessmentSummary?: string, nextQuestion: object | null, dimensionSet?: Array<object> }>}
 */
async function generateScenarioQuestion(dimensionSet, askedQuestionTitles, answers, preSurveyProfile = null, preferredResponseType = null, batchTheme = null, dilemmaAnchor = null, client = null) {
  const result = await generateScenarioQuestionTwoStep(dimensionSet, askedQuestionTitles || [], answers, preSurveyProfile, preferredResponseType, batchTheme, dilemmaAnchor, client);
  return result;
}

module.exports = {
  generateScenarioQuestion,
  buildScenarioStep1UserPrompt,
  buildStep3FormatAndScoreUserPrompt,
  buildTailoringBlock,
  validateNextQuestionObject,
  parseStep1PlainText,
  runCritiquePass,
  formatAndScoreScenario,
  getScenarioOnlySystemPrompt,
  getScenarioStep1SystemPromptWithDimension,
  getScenarioStep3SystemPrompt,
};
