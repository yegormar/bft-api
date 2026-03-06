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
    const legacyPath = path.join(PROJECT_ROOT, 'conf', 'legacy', path.basename(raw));
    if (fs.existsSync(legacyPath)) return legacyPath;
    console.error(`[config] ${envKey} does not exist: ${resolved}`);
    process.exit(1);
  }
  return resolved;
}
const SCENARIO_STEP1_INSTRUCTIONS_PATH = resolveScenarioStepPath('BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE', 'conf/scenario_step1.txt');
const SCENARIO_STEP2_INSTRUCTIONS_PATH = resolveScenarioStepPath('BFT_SCENARIO_STEP2_INSTRUCTIONS_FILE', 'conf/scenario_step2.txt');

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
 * Uses AUDIENCE, STYLE (with secondary blend), AVOID, TONE, COMPLEXITY.
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
- "nextQuestions": array of exactly 3 scenario objects. Each scenario: "title" (string), "description" (string, 2-3 sentences), "type" ("single_choice", "multi_choice", or "rank"), "options" (array of {"text": string, "value": string} only; do NOT include dimensionScores). For "rank" do not use maxSelections. Do NOT include "id".
`;

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
  if (!rawStep1) return 'Generate exactly 3 scenario-based interview questions. Output JSON: { "nextQuestions": [ ... ] }.';
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
  };
  Object.keys(replacements).forEach((key) => {
    step1 = step1.split(key).join(replacements[key]);
  });
  if (primaryDimension && !rawStep1.includes('{{DIMENSION_NAME}}')) {
    step1 = step1 + buildDimensionBlockForStep1(primaryDimension);
  }
  return step1 + STEP1_FORMAT_LINE;
}

function getScenarioOnlySystemPrompt() {
  const step1 = getScenarioStep1Instructions();
  const base = step1 || 'Design one scenario with one clear dilemma and options as direct responses.';
  return base + STEP1_FORMAT_LINE;
}

/**
 * Build Step 2 system prompt. When primaryDimension is provided, prepends the dimension being assessed so the LLM always sees which trait/value is being scored.
 * @param {object} [primaryDimension] - enriched primary dimension (name, dimensionId); when present, prepends "The dimension you are scoring for: ..."
 * @returns {string}
 */
function getScenarioStep2SystemPrompt(primaryDimension) {
  let step2 = getScenarioStep2Instructions();
  if (!step2) step2 = 'Assign dimensionScores (1-5) per option only for dimensions this scenario differentiates. Output JSON: { "optionScores": [ { "dimensionScores": { "dimId": 1..5 } }, ... ] } in option order.';
  if (primaryDimension && primaryDimension.name && primaryDimension.dimensionId) {
    const header = `The dimension you are scoring for: ${primaryDimension.name} (dimension ID: ${primaryDimension.dimensionId}). The user message will list the exact score scale; assign optionScores for the chosen scenario only.\n\n`;
    step2 = header + step2;
  }
  return step2;
}

function buildScenarioStep1UserPrompt(askedTitles, answers, primaryDimension) {
  const lines = [];
  if (primaryDimension && primaryDimension.name && primaryDimension.dimensionId) {
    lines.push(`Design exactly 3 scenarios that probe this dimension: ${primaryDimension.name} (ID: ${primaryDimension.dimensionId}). See the system prompt for description and scoring scale.`);
    lines.push('');
  }
  lines.push('Generate exactly 3 scenarios as specified. Do not include dimensionScores in options.');
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
  lines.push('Reply with one JSON object: { "nextQuestions": [ scenario1, scenario2, scenario3 ] }. No markdown, no code fences.');
  return lines.join('\n');
}

/**
 * Build Step 2 user prompt: all 3 scenarios + primary dimension. LLM chooses best and assigns scores.
 * @param {Array<object>} threeScenarios - 3 questions (title, description, type, options)
 * @param {object} primaryDimension - enriched primary dimension
 * @returns {string}
 */
function buildStep2SelectAndScoreUserPrompt(threeScenarios, primaryDimension) {
  const lines = [
    'You have 3 scenarios below. Choose the best one for this interview, then assign optionScores for the chosen scenario only.',
    '',
    'Primary dimension (required in optionScores):',
    `- ${primaryDimension.dimensionId}: ${primaryDimension.name}`,
    '',
  ];
  const scale = primaryDimension.score_scale && typeof primaryDimension.score_scale === 'object' ? primaryDimension.score_scale : {};
  const interp = scale.interpretation || {};
  lines.push(`Score scale for ${primaryDimension.dimensionId}: low (1-2) = ${interp.low || 'low'}; medium (3) = ${interp.medium || 'medium'}; high (4-5) = ${interp.high || 'high'}.`);
  lines.push('');
  threeScenarios.forEach((q, idx) => {
    lines.push(`--- Scenario ${idx} ---`);
    lines.push(`Title: ${(q.title || '').trim() || '(none)'}`);
    lines.push(`Description: ${(q.description || '').trim() || '(none)'}`);
    lines.push(`Type: ${q.type || 'single_choice'}`);
    lines.push('Options:');
    (q.options || []).forEach((opt, i) => {
      lines.push(`  ${i + 1}. value="${opt.value}" text="${(opt.text || '').trim() || ''}"`);
    });
    lines.push('');
  });
  lines.push('Reply with JSON: { "chosenScenarioIndex": 0|1|2, "optionScores": [ { "dimensionScores": { "' + primaryDimension.dimensionId + '": 1-5, ... } }, ... ] }. optionScores must have one element per option of the CHOSEN scenario only. You may add other dimension IDs to dimensionScores if the scenario clearly differentiates them.');
  return lines.join('\n');
}

function getChatClient(client) {
  return client || ollamaClient;
}

async function generateScenarioOnly(primaryDimension, askedTitles, answers, preSurveyProfile, client = null) {
  const chat = getChatClient(client);
  const tailoring = buildTailoringBlock(preSurveyProfile);
  const systemContent =
    getScenarioStep1SystemPromptWithDimension(primaryDimension)
    + (tailoring ? '\n\n' + tailoring : '');
  const userContent = buildScenarioStep1UserPrompt(askedTitles || [], answers, primaryDimension);
  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
  let content = (await chat.chat(messages)).content;
  let parsed = parseResponse(content);
  let nextQuestions = Array.isArray(parsed && parsed.nextQuestions) ? parsed.nextQuestions : [];
  if (nextQuestions.length !== 3) {
    console.warn('[LLM] Step 1 expected 3 scenarios, got:', nextQuestions.length);
    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content: 'You must reply with exactly 3 scenarios in the "nextQuestions" array. Reply with one JSON object: { "nextQuestions": [ scenario1, scenario2, scenario3 ] }. No markdown.',
    });
    content = (await chat.chat(messages)).content;
    parsed = parseResponse(content);
    nextQuestions = Array.isArray(parsed && parsed.nextQuestions) ? parsed.nextQuestions : [];
    if (nextQuestions.length !== 3) return null;
  }
  const validated = [];
  for (let i = 0; i < 3; i++) {
    const q = nextQuestions[i];
    const validation = q ? validateNextQuestionObject(q, true, null) : { valid: false, errors: ['Missing scenario.'] };
    if (!validation.valid) {
      console.warn('[LLM] Step 1 scenario', i, 'validation failed:', validation.errors);
      return null;
    }
    const { id, ...rest } = q;
    validated.push(rest);
  }
  return { nextQuestions: validated };
}

/**
 * Step 2: one LLM call with all 3 scenarios. LLM chooses best and assigns optionScores for chosen scenario.
 * Returns the chosen question with dimensionScores merged and dimensionSet (primary + any secondary from optionScores).
 * @param {Array<object>} threeScenarios - 3 questions (title, description, type, options without dimensionScores)
 * @param {object} primaryDimension - enriched primary dimension
 * @param {{ chat: function } | null} [client] - Optional chat client for tests (fake Ollama). If null, uses ollamaClient.
 * @returns {Promise<{ question: object, dimensionSet: Array<{ dimensionType: string, dimensionId: string }> } | null>}
 */
async function selectBestScenarioAndAssignScores(threeScenarios, primaryDimension, client = null) {
  const chat = getChatClient(client);
  const systemContent = getScenarioStep2SystemPrompt(primaryDimension);
  const userContent = buildStep2SelectAndScoreUserPrompt(threeScenarios, primaryDimension);
  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];
  const content = (await chat.chat(messages)).content;
  const parsed = parseResponse(content);
  const chosenIndex = parsed && typeof parsed.chosenScenarioIndex === 'number' ? parsed.chosenScenarioIndex : null;
  if (chosenIndex == null || chosenIndex < 0 || chosenIndex > 2) {
    console.warn('[LLM] Step 2 invalid chosenScenarioIndex:', chosenIndex);
    return null;
  }
  const chosen = threeScenarios[chosenIndex];
  if (!chosen || !Array.isArray(chosen.options)) {
    console.warn('[LLM] Step 2 chosen scenario missing or has no options');
    return null;
  }
  const optionScores = Array.isArray(parsed.optionScores) ? parsed.optionScores : [];
  if (optionScores.length !== chosen.options.length) {
    console.warn('[LLM] Step 2 optionScores length', optionScores.length, 'does not match chosen scenario options', chosen.options.length);
    return null;
  }
  const scoreMin = primaryDimension.score_scale && primaryDimension.score_scale.min != null ? primaryDimension.score_scale.min : 1;
  const scoreMax = primaryDimension.score_scale && primaryDimension.score_scale.max != null ? primaryDimension.score_scale.max : 5;
  const primaryId = primaryDimension.dimensionId;
  const allDimensionIds = new Set([primaryId]);
  for (const item of optionScores) {
    if (item && item.dimensionScores && typeof item.dimensionScores === 'object') {
      Object.keys(item.dimensionScores).forEach((id) => allDimensionIds.add(id));
    }
  }
  for (const item of optionScores) {
    if (!item || !item.dimensionScores || typeof item.dimensionScores[primaryId] !== 'number') {
      console.warn('[LLM] Step 2 optionScores missing primary dimension', primaryId);
      return null;
    }
    const n = Number(item.dimensionScores[primaryId]);
    if (!Number.isInteger(n) || n < scoreMin || n > scoreMax) {
      console.warn('[LLM] Step 2 primary score out of range:', item.dimensionScores[primaryId]);
      return null;
    }
  }
  const question = { ...chosen, options: chosen.options.map((opt, i) => ({ ...opt, dimensionScores: (optionScores[i] && optionScores[i].dimensionScores) || {} })) };
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

async function generateScenarioQuestionTwoStep(dimensionSet, askedTitles, answers, preSurveyProfile, preferredResponseType, batchTheme, dilemmaAnchor, client = null) {
  if (!dimensionSet || dimensionSet.length === 0) return { assessmentSummary: null, nextQuestion: null };
  const primary = dimensionSet[0];

  const step1Result = await generateScenarioOnly(primary, askedTitles || [], answers, preSurveyProfile, client);
  if (!step1Result || !step1Result.nextQuestions || step1Result.nextQuestions.length !== 3) return { assessmentSummary: null, nextQuestion: null };

  const step2Result = await selectBestScenarioAndAssignScores(step1Result.nextQuestions, primary, client);
  if (!step2Result || !step2Result.question) return { assessmentSummary: null, nextQuestion: null };

  const question = step2Result.question;
  const dimensionSetForValidation = step2Result.dimensionSet || [primary];
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
    console.warn('[LLM] Merged question validation failed:', finalValidation.errors);
    return { assessmentSummary: null, nextQuestion: null };
  }
  return { assessmentSummary: null, nextQuestion: question, dimensionSet: step2Result.dimensionSet };
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
  buildTailoringBlock,
  validateNextQuestionObject,
  getScenarioOnlySystemPrompt,
  getScenarioStep1SystemPromptWithDimension,
  getScenarioStep2SystemPrompt,
};
