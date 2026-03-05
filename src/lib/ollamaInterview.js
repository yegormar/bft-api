/**
 * Uses Ollama to assess answers and generate the next interview question
 * for Built for Tomorrow. Expects Ollama to return JSON.
 * System prompt is loaded from conf/ via config/llm.js when set.
 * Pre-survey profile (dominant clusters, demographics) is used to tailor tone and style.
 */

const path = require('path');
const fs = require('fs');
const ollamaClient = require('./ollamaClient');
const llmConfig = require('../../config/llm');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PERSONALITY_CLUSTERS_PATH = path.join(PROJECT_ROOT, 'conf', 'personality_clusters.json');
const SCENARIO_DESIGN_INSTRUCTIONS_PATH = path.join(PROJECT_ROOT, 'conf', 'scenario_design_instructions.txt');
const FORBIDDEN_SCENARIO_WORDS_PATH = path.join(PROJECT_ROOT, 'conf', 'forbidden_scenario_words.txt');

const DEFAULT_FORBIDDEN_SCENARIO_WORDS = [
  'responsibility',
  'full responsibility',
  'integrity',
  'balance',
  'work-life',
  'challenge',
  'flexibility',
  'teamwork',
  'delegate',
  'delegation',
  'stretch goal',
  'comfort zone',
  'free time',
  'split the work',
  'divide the task',
  'take charge',
  'other commitments',
  'take full responsibility',
];

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
const SCENARIO_STEP1_INSTRUCTIONS_PATH = resolveScenarioStepPath('BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE', 'conf/scenario_step1_instructions.txt');
const SCENARIO_STEP2_INSTRUCTIONS_PATH = resolveScenarioStepPath('BFT_SCENARIO_STEP2_INSTRUCTIONS_FILE', 'conf/scenario_step2_instructions.txt');

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

/** Human-readable labels for scenario settings in the tailoring prompt. */
const SCENARIO_SETTING_LABELS = {
  school: 'school (projects, classes, deadlines)',
  work: 'work or part-time job',
  hobbies: 'hobbies or side projects',
  sports: 'sports or team activities',
  social: 'friends or social situations',
  online: 'online or tech (games, apps, communities)',
};

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
 * Uses AUDIENCE, SETTINGS, STYLE (with secondary blend), AVOID, TONE, COMPLEXITY.
 */
function buildTailoringBlock(preSurveyProfile) {
  if (!preSurveyProfile || typeof preSurveyProfile !== 'object') return '';
  const clusters = getPersonalityClusters();
  const byShort = new Map(clusters.map((c) => [c.name, c.short]));
  const byAvoid = new Map(clusters.filter((c) => c.avoid).map((c) => [c.name, c.avoid]));

  const lines = [];

  // AUDIENCE
  const demographics = preSurveyProfile.demographics;
  if (demographics && (demographics.ageGroup || demographics.gender)) {
    const audience = [demographics.ageGroup, demographics.gender].filter(Boolean).join(', ');
    if (audience) lines.push(`AUDIENCE: ${audience}.`);
  }

  // SETTINGS: preferred scenario contexts from Q7
  const preferredSettings = preSurveyProfile.preferredSettings;
  if (Array.isArray(preferredSettings) && preferredSettings.length > 0) {
    const labels = preferredSettings
      .map((s) => SCENARIO_SETTING_LABELS[s] || s)
      .join(', ');
    lines.push(`SETTINGS: Prefer scenarios set in: ${labels}. Anchor dilemmas in these contexts when possible.`);
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

  // AVOID: clusters not chosen (exclude neutral)
  const avoidClusters = preSurveyProfile.avoidClusters;
  if (Array.isArray(avoidClusters) && avoidClusters.length > 0) {
    const avoidPhrases = avoidClusters
      .map((name) => byAvoid.get(name) || `avoid ${byShort.get(name) || name} framing`)
      .filter(Boolean);
    if (avoidPhrases.length > 0) {
      lines.push(`AVOID: ${avoidPhrases.join('; ')}. Do not use these framings.`);
    }
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

const FALLBACK_SYSTEM_PROMPT = `You are the Built for Tomorrow interview assistant. Reply with exactly one JSON object. No markdown. "completed" must be boolean; when false, "nextQuestion" must be an object with "id" (string), "title" (string), optional "description", "type" ("single_choice" or "multi_choice"), and "options" (array of {"text": string, "value": string}). When completed is true, set "nextQuestion" to null.`;

function getSystemPrompt(preSurveyProfile = null) {
  const fromFile = llmConfig.getSystemPrompt && llmConfig.getSystemPrompt();
  const base = (fromFile && fromFile.trim()) ? fromFile.trim() : FALLBACK_SYSTEM_PROMPT;
  const tailoring = buildTailoringBlock(preSurveyProfile);
  return base + tailoring;
}

/**
 * Build user prompt from current answers and optional new answer.
 */
function buildUserPrompt(answers, lastAnswerText = null) {
  const lines = ['Answers so far:'];
  answers.forEach((a, i) => {
    const q = a.questionId || a.questionTitle || `Q${i + 1}`;
    const v = a.value ?? a.selected ?? a.answer ?? a.text ?? JSON.stringify(a);
    lines.push(`- ${q}: ${v}`);
  });
  if (lastAnswerText) {
    lines.push('');
    lines.push(`Latest answer (for assessment): ${lastAnswerText}`);
  }
  lines.push('');
  lines.push('Provide your JSON response: assessmentSummary (optional), completed, nextQuestion.');
  return lines.join('\n');
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

/**
 * Validate parsed LLM response against the schema required by the UI.
 * @param {object} parsed - Parsed JSON from LLM
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAssessmentResponse(parsed) {
  const errors = [];
  if (parsed == null || typeof parsed !== 'object') {
    return { valid: false, errors: ['Response is not a JSON object.'] };
  }
  if (typeof parsed.completed !== 'boolean') {
    errors.push('"completed" must be a boolean (true or false).');
  }
  if (parsed.completed === true) {
    if (parsed.nextQuestion != null) {
      errors.push('When "completed" is true, "nextQuestion" must be null.');
    }
    return { valid: errors.length === 0, errors };
  }
  const qResult = validateNextQuestionObject(parsed.nextQuestion, false);
  if (!qResult.valid) errors.push(...qResult.errors);
  return { valid: errors.length === 0, errors };
}

function buildCorrectionUserMessage(rawContent, validationErrors) {
  const lines = [
    'Your previous response was invalid. Fix the following and reply with ONLY a valid JSON object (no markdown, no explanation):',
    '',
    'Validation errors:',
    ...validationErrors.map((e) => `- ${e}`),
    '',
    'Your previous response was:',
    rawContent,
    '',
    'Reply now with a single valid JSON object in the exact format specified in the system prompt.',
  ];
  return lines.join('\n');
}

function getScenarioDesignInstructions() {
  try {
    return fs.readFileSync(SCENARIO_DESIGN_INSTRUCTIONS_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

function getForbiddenWordsList() {
  try {
    if (fs.existsSync(FORBIDDEN_SCENARIO_WORDS_PATH)) {
      const raw = fs.readFileSync(FORBIDDEN_SCENARIO_WORDS_PATH, 'utf8');
      const terms = raw
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter((t) => t.length > 0 && !t.startsWith('#'));
      return terms.length > 0 ? terms : DEFAULT_FORBIDDEN_SCENARIO_WORDS;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_FORBIDDEN_SCENARIO_WORDS;
}

/**
 * Check scenario title, description, and option texts for forbidden words (case-insensitive substring).
 * @param {object} question - { title?, description?, options?: Array<{ text? }> }
 * @param {string[]} forbiddenList - list of forbidden terms (lowercase)
 * @returns {{ ok: boolean, found: string[] }}
 */
function checkForbiddenWords(question, forbiddenList) {
  const found = [];
  const texts = [];
  if (question.title && typeof question.title === 'string') texts.push(question.title);
  if (question.description && typeof question.description === 'string') texts.push(question.description);
  (question.options || []).forEach((opt) => {
    if (opt && typeof opt.text === 'string') texts.push(opt.text);
  });
  const combined = texts.join(' ').toLowerCase();
  (forbiddenList || []).forEach((term) => {
    if (term && combined.includes(term.toLowerCase())) found.push(term);
  });
  return { ok: found.length === 0, found };
}

function getScenarioStep1Instructions() {
  try {
    return fs.readFileSync(SCENARIO_STEP1_INSTRUCTIONS_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

function getScenarioStep2Instructions() {
  try {
    return fs.readFileSync(SCENARIO_STEP2_INSTRUCTIONS_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

const STEP1_FORMAT_LINE = `
Response format: reply with exactly one JSON object. No markdown, no code fences.
- "completed": false
- "nextQuestion": object with "title" (string), "description" (string, 2-3 sentence scenario), "type" ("single_choice", "multi_choice", or "rank"), "options" (array of {"text": string, "value": string} only; do NOT include dimensionScores). For "rank" do not use maxSelections. Do NOT include "id".
- "assessmentSummary": optional 1-2 sentence summary.
`;

function getScenarioOnlySystemPrompt() {
  const designInstructions = getScenarioDesignInstructions();
  const step1 = getScenarioStep1Instructions();
  const base = step1 || 'Design one scenario with one clear dilemma and options as direct responses.';
  const combined = designInstructions ? designInstructions + '\n\n---\n\n' + base : base;
  return combined + STEP1_FORMAT_LINE;
}

function getScenarioStep2SystemPrompt() {
  const step2 = getScenarioStep2Instructions();
  return step2 || 'Assign dimensionScores (1-5) per option only for dimensions this scenario differentiates. Output JSON: { "optionScores": [ { "dimensionScores": { "dimId": 1..5 } }, ... ] } in option order.';
}

function buildScenarioOnlyUserPrompt(primaryDimension, batchTheme, askedTitles, answers, preferredResponseType, dilemmaAnchor) {
  const lines = ['Generate one scenario-based interview question.'];
  const anchor = typeof dilemmaAnchor === 'string' && dilemmaAnchor.trim() ? dilemmaAnchor.trim() : null;
  if (anchor) {
    lines.push('Dilemma anchor (situation only, no trait words): ' + anchor);
  } else {
    lines.push('Design one concrete dilemma with a real trade-off. Different choices should be defensible; do not name any trait or value.');
  }
  lines.push('Do not include dimensionScores in options. Output options with only "text" and "value".');
  if (preferredResponseType && ['single_choice', 'multi_choice', 'rank'].includes(preferredResponseType)) {
    lines.push(`Preferred response type: ${preferredResponseType}. Use it if it fits; otherwise choose the best fit.`);
  }
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
  lines.push('Reply with one JSON object: { "completed": false, "nextQuestion": { "title", "description", "type", "options" (each with "text", "value" only) }, "assessmentSummary"?: "..." }. No "id" in nextQuestion.');
  return lines.join('\n');
}

function buildAssignScoresUserPrompt(question, dimensionSet) {
  const lines = [
    'Assign dimensionScores (1-5) for each option. Include only dimensions that this scenario actually differentiates; omit dimensions not relevant to the choices.',
    '',
    'Scenario:',
    `Title: ${(question.title || '').trim() || '(none)'}`,
    `Description: ${(question.description || '').trim() || '(none)'}`,
    '',
    'Options (in order):',
  ];
  (question.options || []).forEach((opt, i) => {
    lines.push(`${i + 1}. value="${opt.value}" text="${(opt.text || '').trim() || ''}"`);
  });
  const dimensionsWithScale = (dimensionSet || []).filter((d) => d.score_scale && typeof d.score_scale === 'object');
  if (dimensionsWithScale.length > 0) {
    lines.push('');
    lines.push('Dimensions (assign only those that apply to this scenario). Score 1-5 per dimension that applies:');
    dimensionsWithScale.forEach((d) => {
      const scale = d.score_scale;
      const min = scale.min != null ? scale.min : 1;
      const max = scale.max != null ? scale.max : 5;
      const interp = scale.interpretation || {};
      lines.push(`- ${d.dimensionId} (min=${min}, max=${max}): low = ${interp.low || 'low'}; medium = ${interp.medium || 'neutral'}; high = ${interp.high || 'high'}.`);
    });
  }
  lines.push('');
  lines.push('Reply with one JSON object: { "optionScores": [ { "dimensionScores": { "dimId": 1..5, ... } }, ... ] } with one element per option in the same order. Include only dimension IDs that this scenario differentiates.');
  return lines.join('\n');
}

async function generateScenarioOnly(primaryDimension, batchTheme, askedTitles, answers, preSurveyProfile, preferredResponseType, dilemmaAnchor) {
  const tailoring = buildTailoringBlock(preSurveyProfile);
  const systemContent = getScenarioOnlySystemPrompt() + tailoring;
  const userContent = buildScenarioOnlyUserPrompt(primaryDimension, batchTheme, askedTitles || [], answers, preferredResponseType, dilemmaAnchor);
  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
  let content = (await ollamaClient.chat(messages)).content;
  let parsed = parseResponse(content);
  let q = parsed && parsed.nextQuestion;
  let validation = q ? validateNextQuestionObject(q, true, null) : { valid: false, errors: ['Missing nextQuestion.'] };
  if (!validation.valid) {
    console.warn('[LLM] Step 1 scenario validation failed, requesting one correction:', validation.errors);
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: buildCorrectionUserMessage(content, validation.errors) });
    content = (await ollamaClient.chat(messages)).content;
    parsed = parseResponse(content);
    q = parsed && parsed.nextQuestion;
    validation = q ? validateNextQuestionObject(q, true, null) : { valid: false, errors: ['Missing nextQuestion.'] };
    if (!validation.valid) {
      console.warn('[LLM] Step 1 correction still invalid:', validation.errors);
      return null;
    }
  }
  const forbiddenList = getForbiddenWordsList();
  let forbiddenCheck = checkForbiddenWords(q, forbiddenList);
  if (!forbiddenCheck.ok) {
    console.warn('[LLM] Step 1 scenario contains forbidden words, requesting one revision:', forbiddenCheck.found);
    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content: `Your scenario or options contain words we must avoid: ${forbiddenCheck.found.join(', ')}. Reply with a revised scenario (same JSON format) that avoids these words.`,
    });
    content = (await ollamaClient.chat(messages)).content;
    parsed = parseResponse(content);
    q = parsed && parsed.nextQuestion;
    const revalidate = q ? validateNextQuestionObject(q, true, null) : { valid: false, errors: ['Missing nextQuestion.'] };
    if (!revalidate.valid) {
      console.warn('[LLM] Step 1 revision after forbidden-words check failed validation:', revalidate.errors);
      return null;
    }
    forbiddenCheck = checkForbiddenWords(q, forbiddenList);
    if (!forbiddenCheck.ok) {
      console.warn('[LLM] Step 1 revision still contains forbidden words:', forbiddenCheck.found);
      return null;
    }
  }
  const { id, ...rest } = q;
  return { nextQuestion: rest, assessmentSummary: parsed.assessmentSummary || null };
}

function validateOptionScoresResponse(optionScores, question, allowedDimensionIds, scoreMin, scoreMax) {
  if (!Array.isArray(optionScores) || optionScores.length !== (question.options && question.options.length)) {
    return { valid: false, errors: [`optionScores must be an array of length ${question.options?.length || 0}.`] };
  }
  const allowedSet = new Set(allowedDimensionIds || []);
  const errors = [];
  optionScores.forEach((item, i) => {
    if (item == null || typeof item !== 'object') {
      errors.push(`optionScores[${i}] must be an object with "dimensionScores".`);
      return;
    }
    const ds = item.dimensionScores;
    if (ds == null || typeof ds !== 'object') {
      errors.push(`optionScores[${i}].dimensionScores must be an object.`);
      return;
    }
    Object.keys(ds).forEach((dimId) => {
      if (!allowedSet.has(dimId)) {
        errors.push(`optionScores[${i}].dimensionScores has unexpected key "${dimId}". Allowed: ${allowedDimensionIds.join(', ')}.`);
      }
      const v = ds[dimId];
      const n = Number(v);
      if (!Number.isInteger(n) || n < scoreMin || n > scoreMax) {
        errors.push(`optionScores[${i}].dimensionScores.${dimId} must be an integer from ${scoreMin} to ${scoreMax}. Got: ${v}.`);
      }
    });
  });
  return { valid: errors.length === 0, errors };
}

async function assignDimensionScores(question, dimensionSet) {
  const dimensionsWithScale = (dimensionSet || []).filter((d) => d.score_scale && typeof d.score_scale === 'object');
  const allowedIds = dimensionsWithScale.map((d) => d.dimensionId);
  const scoreMin = dimensionsWithScale[0]?.score_scale?.min != null ? dimensionsWithScale[0].score_scale.min : 1;
  const scoreMax = dimensionsWithScale[0]?.score_scale?.max != null ? dimensionsWithScale[0].score_scale.max : 5;

  const systemContent = getScenarioStep2SystemPrompt();
  const userContent = buildAssignScoresUserPrompt(question, dimensionSet);
  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
  let content = (await ollamaClient.chat(messages)).content;
  let parsed = parseResponse(content);
  let optionScores = parsed && parsed.optionScores;
  let validation = validateOptionScoresResponse(optionScores, question, allowedIds, scoreMin, scoreMax);
  if (!validation.valid) {
    console.warn('[LLM] Step 2 optionScores validation failed, requesting one correction:', validation.errors);
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: buildCorrectionUserMessage(content, validation.errors) });
    content = (await ollamaClient.chat(messages)).content;
    parsed = parseResponse(content);
    optionScores = parsed && parsed.optionScores;
    validation = validateOptionScoresResponse(optionScores, question, allowedIds, scoreMin, scoreMax);
    if (!validation.valid) {
      console.warn('[LLM] Step 2 correction still invalid:', validation.errors);
      return null;
    }
  }
  return optionScores;
}

async function generateScenarioQuestionTwoStep(dimensionSet, askedTitles, answers, preSurveyProfile, preferredResponseType, batchTheme, dilemmaAnchor) {
  if (!dimensionSet || dimensionSet.length === 0) return { assessmentSummary: null, nextQuestion: null };
  const primary = dimensionSet[0];
  const theme = batchTheme && typeof batchTheme === 'string' ? batchTheme.trim() : null;
  const anchor = dilemmaAnchor && typeof dilemmaAnchor === 'string' ? dilemmaAnchor.trim() : null;

  const step1Result = await generateScenarioOnly(primary, theme, askedTitles || [], answers, preSurveyProfile, preferredResponseType, anchor);
  if (!step1Result || !step1Result.nextQuestion) return { assessmentSummary: step1Result?.assessmentSummary || null, nextQuestion: null };
  const question = step1Result.nextQuestion;

  const optionScores = await assignDimensionScores(question, dimensionSet);
  if (!optionScores) return { assessmentSummary: step1Result.assessmentSummary || null, nextQuestion: null };

  for (let i = 0; i < question.options.length; i++) {
    question.options[i].dimensionScores = optionScores[i] && optionScores[i].dimensionScores ? optionScores[i].dimensionScores : {};
  }

  const dimensionsWithScale = dimensionSet.filter((d) => d.score_scale && typeof d.score_scale === 'object');
  const scoringOptions =
    dimensionsWithScale.length > 0
      ? {
          expectedDimensionIds: dimensionsWithScale.map((d) => d.dimensionId),
          scoreMin: dimensionsWithScale[0].score_scale.min != null ? dimensionsWithScale[0].score_scale.min : 1,
          scoreMax: dimensionsWithScale[0].score_scale.max != null ? dimensionsWithScale[0].score_scale.max : 5,
          allowPartialDimensionScores: true,
        }
      : null;
  const finalValidation = validateNextQuestionObject(question, true, scoringOptions);
  if (!finalValidation.valid) {
    console.warn('[LLM] Merged question validation failed:', finalValidation.errors);
    return { assessmentSummary: step1Result.assessmentSummary || null, nextQuestion: null };
  }
  return { assessmentSummary: step1Result.assessmentSummary || null, nextQuestion: question };
}

const SCENARIO_SYSTEM_BASE = `You are the Built for Tomorrow interview assistant. Your task is to generate exactly ONE scenario-based interview question.

You will be given a set of dimensions (aptitudes, traits, values, or skills) to probe. Create a single question that feels like a real situation (e.g. "Imagine you're leading a project and the requirements keep changing...") so we can infer something about those dimensions from the answer. Do NOT ask separate questions per dimension; weave them into one scenario. Do NOT use the dimension names or obvious synonyms (e.g. balance, free time, challenge, flexibility) in the scenario or options—the situation and choices should imply them without naming them.

Scoring: For each option you output, you must also output a "dimensionScores" object. The user message will list the exact dimension IDs to use as keys and the score meaning (low/medium/high) for each dimension. For each option, set dimensionScores so that each dimension ID has an integer from 1 to 5: 1-2 = low alignment with that dimension, 3 = neutral/mixed, 4-5 = high alignment. You design the scenario and options, so you know how much each choice implies high or low on each dimension; use the per-dimension interpretation text in the user message to assign scores consistently.

Response format — reply with exactly one JSON object. No markdown, no code fences.
- "completed": false (we are not ending the interview).
- "nextQuestion": object with "title" (string), "description" (string, REQUIRED: the 2–3 sentence scenario setup and dilemma that the person reads before the options), "type" ("single_choice", "multi_choice", or "rank"), "options" (array of {"text": string, "value": string, "dimensionScores": object}). Each option must have "dimensionScores": an object whose keys are the dimension IDs listed in the user message and whose values are integers 1-5. For "rank", the user will order the options; do not use maxSelections. Do NOT include "id" — we assign it server-side.
- "assessmentSummary": optional 1–2 sentence summary of what the answer might suggest.

Do not repeat or rephrase questions you are told were already asked.`;

function getScenarioSystemPrompt() {
  const designInstructions = getScenarioDesignInstructions();
  if (designInstructions) {
    return designInstructions + '\n\n---\n\n' + SCENARIO_SYSTEM_BASE;
  }
  return SCENARIO_SYSTEM_BASE;
}

function buildScenarioUserPrompt(dimensionSet, askedTitles, answers, preferredResponseType = null) {
  const lines = [
    'Generate one scenario-based interview question that naturally probes the following dimensions.',
    'Do not use the dimension names or their obvious synonyms (e.g. balance, free time, challenge, flexibility, stretch goal) in the scenario or options—let the situation and the choices imply them.',
    '',
    'Dimensions to probe:',
  ];
  dimensionSet.forEach((d) => {
    lines.push(`- ${d.dimensionType} "${d.name}": ${d.how_measured_or_observed || 'Use question_hints below.'}`);
    if (Array.isArray(d.question_hints) && d.question_hints.length > 0) {
      d.question_hints.forEach((h) => lines.push(`  Hint: ${h}`));
    }
  });

  const dimensionsWithScale = (dimensionSet || []).filter((d) => d.score_scale && typeof d.score_scale === 'object');
  if (dimensionsWithScale.length > 0) {
    lines.push('');
    lines.push('Score scale (use for dimensionScores). For each dimension, assign 1-5 per option based on what that choice implies:');
    dimensionsWithScale.forEach((d) => {
      const scale = d.score_scale;
      const min = scale.min != null ? scale.min : 1;
      const max = scale.max != null ? scale.max : 5;
      const interp = scale.interpretation || {};
      lines.push(`- dimensionId "${d.dimensionId}" (min=${min}, max=${max}): low = ${interp.low || 'low alignment'}; medium = ${interp.medium || 'neutral'}; high = ${interp.high || 'high alignment'}.`);
    });
    lines.push('');
    lines.push('Dimension IDs to use as keys in dimensionScores: ' + dimensionsWithScale.map((d) => d.dimensionId).join(', ') + '.');
  }

  if (preferredResponseType && ['single_choice', 'multi_choice', 'rank'].includes(preferredResponseType)) {
    lines.push('');
    lines.push(`Preferred response type for this scenario: ${preferredResponseType}. Use this type if it fits the situation; otherwise choose the best fit.`);
  }
  if (askedTitles.length > 0) {
    lines.push('');
    lines.push('Do not repeat or rephrase these already-asked questions:');
    askedTitles.forEach((t) => lines.push(`- ${t}`));
  }
  lines.push('');
  lines.push('Answers so far (for context). Each line is: question asked → option value(s) the user chose (for rank, an ordered array):');
  (answers || []).forEach((a, i) => {
    const title = (askedTitles && askedTitles[i]) ? askedTitles[i] : (a.questionId || a.questionTitle || `Q${i + 1}`);
    const v = a.value ?? a.selected ?? a.answer ?? a.text ?? JSON.stringify(a);
    lines.push(`- "${title}" → ${Array.isArray(v) ? JSON.stringify(v) : v}`);
  });
  lines.push('');
  lines.push('Reply with one JSON object: { "completed": false, "nextQuestion": { "title", "description" (REQUIRED: 2–3 sentence scenario), "type", "options" (each with "text", "value", "dimensionScores") }, "assessmentSummary"?: "..." }. No "id" in nextQuestion.');
  return lines.join('\n');
}

/**
 * Generate one scenario-based question that probes the given dimension set.
 * Uses two-step flow: step 1 scenario only (primary/theme), step 2 assign dimensionScores (partial allowed).
 * @param {Array<object>} dimensionSet - [{ dimensionType, dimensionId, name, question_hints, how_measured_or_observed, score_scale? }]
 * @param {string[]} askedQuestionTitles - Titles of questions already asked (for deduplication)
 * @param {Array<object>} answers - Previous answers
 * @param {object} [preSurveyProfile] - Pre-survey profile for tailoring
 * @param {string} [preferredResponseType] - single_choice, multi_choice, or rank
 * @param {string} [batchTheme] - Optional batch theme for step 1 (e.g. "Team, belonging, and ownership")
 * @param {string} [dilemmaAnchor] - Optional situation-only hint for step 1 (no trait words)
 * @returns {Promise<{ assessmentSummary?: string, nextQuestion: object | null }>}
 */
async function generateScenarioQuestion(dimensionSet, askedQuestionTitles, answers, preSurveyProfile = null, preferredResponseType = null, batchTheme = null, dilemmaAnchor = null) {
  return generateScenarioQuestionTwoStep(dimensionSet, askedQuestionTitles || [], answers, preSurveyProfile, preferredResponseType, batchTheme, dilemmaAnchor);
}

/**
 * Call Ollama to assess the current answers and get the next question.
 * @param {Array<object>} answers - List of { questionId, value } or similar
 * @param {string} [lastAnswerText] - Optional text of the latest answer for assessment
 * @param {object} [preSurveyProfile] - Optional { dominant, secondaryTone, demographics } from pre-survey
 * @returns {Promise<{ assessmentSummary?: string, completed: boolean, nextQuestion: object | null }>}
 */
const LOG_BORDER = '──────────────────────────────────────────────────────────────';

function logPromptTailoring(preSurveyProfile) {
  const clusters = getPersonalityClusters();
  console.log(`\n${LOG_BORDER}`);
  console.log('[LLM] Personality clusters (short descriptions used in tailoring)');
  console.log(LOG_BORDER);
  if (clusters.length === 0) {
    console.log('  (none loaded)');
  } else {
    clusters.forEach((c) => console.log(`  ${c.name}: "${c.short}"`));
  }
  const tailoring = buildTailoringBlock(preSurveyProfile);
  console.log(LOG_BORDER);
  console.log('[LLM] Tailoring block (appended to system prompt from pre-survey)');
  console.log(LOG_BORDER);
  if (!tailoring) {
    console.log('  (none — no pre-survey profile or empty)');
  } else {
    console.log(tailoring);
  }
  console.log(`${LOG_BORDER}\n`);
}

const MAX_VALIDATION_RETRIES = 1;

async function assessAndGetNextQuestion(answers, lastAnswerText = null, preSurveyProfile = null) {
  logPromptTailoring(preSurveyProfile);
  const systemContent = getSystemPrompt(preSurveyProfile);
  let messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: buildUserPrompt(answers, lastAnswerText) },
  ];

  let content = (await ollamaClient.chat(messages)).content;
  let parsed = parseResponse(content);
  let validation = parsed ? validateAssessmentResponse(parsed) : { valid: false, errors: ['Response could not be parsed as JSON.'] };

  if (!validation.valid && MAX_VALIDATION_RETRIES > 0) {
    console.warn('[LLM] Response failed validation, requesting correction:', validation.errors);
    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content: buildCorrectionUserMessage(content, validation.errors),
    });
    content = (await ollamaClient.chat(messages)).content;
    parsed = parseResponse(content);
    validation = parsed ? validateAssessmentResponse(parsed) : { valid: false, errors: ['Corrected response could not be parsed as JSON.'] };
    if (!validation.valid) {
      console.warn('[LLM] Corrected response still invalid:', validation.errors);
    }
  }

  if (!validation.valid || !parsed || typeof parsed.completed !== 'boolean') {
    return { assessmentSummary: null, completed: false, nextQuestion: null };
  }
  return {
    assessmentSummary: parsed.assessmentSummary || null,
    completed: parsed.completed === true,
    nextQuestion: parsed.nextQuestion ?? null,
  };
}

module.exports = {
  assessAndGetNextQuestion,
  generateScenarioQuestion,
  buildUserPrompt,
  buildScenarioUserPrompt,
  buildScenarioOnlyUserPrompt,
  buildTailoringBlock,
  validateNextQuestionObject,
  checkForbiddenWords,
  getForbiddenWordsList,
  getScenarioOnlySystemPrompt,
};
