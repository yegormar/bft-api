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

let personalityClustersCache = null;

function getPersonalityClusters() {
  if (personalityClustersCache) return personalityClustersCache;
  try {
    const raw = fs.readFileSync(PERSONALITY_CLUSTERS_PATH, 'utf8');
    const data = JSON.parse(raw);
    personalityClustersCache = (data.clusters || []).map((c) => ({
      name: c.name,
      short: c.short || c.name,
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

/**
 * Build a short, non-contradictory tailoring block for the system prompt.
 * Uses AUDIENCE / STYLE / TONE so the LLM gets one clear instruction.
 */
function buildTailoringBlock(preSurveyProfile) {
  if (!preSurveyProfile || typeof preSurveyProfile !== 'object') return '';
  const clusters = getPersonalityClusters();
  const byShort = new Map(clusters.map((c) => [c.name, c.short]));

  const lines = [];
  const demographics = preSurveyProfile.demographics;
  if (demographics && (demographics.ageGroup || demographics.gender)) {
    const audience = [demographics.ageGroup, demographics.gender].filter(Boolean).join(', ');
    if (audience) lines.push(`AUDIENCE: ${audience}.`);
  }

  const dominant = preSurveyProfile.dominant;
  const styleLine = synthesizeStyleLine(dominant, byShort);
  if (styleLine) lines.push(`STYLE: ${styleLine}`);

  const secondaryTone = preSurveyProfile.secondaryTone;
  if (secondaryTone && secondaryTone !== 'neutral') {
    const toneShort = byShort.get(secondaryTone);
    if (toneShort) lines.push(`TONE: ${toneShort}.`);
  }

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
 */
function validateNextQuestionObject(q, idOptional = false) {
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
  if (q.description != null && typeof q.description !== 'string') {
    errors.push('"nextQuestion.description" must be a string or omitted.');
  }
  if (!VALID_TYPES.has(q.type)) {
    errors.push(`"nextQuestion.type" must be one of "single_choice", "multi_choice", or "rank". Got: ${JSON.stringify(q.type)}.`);
  }
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

const SCENARIO_SYSTEM_BASE = `You are the Built for Tomorrow interview assistant. Your task is to generate exactly ONE scenario-based interview question.

You will be given a set of dimensions (aptitudes, traits, values, or skills) to probe. Create a single question that feels like a real situation (e.g. "Imagine you're leading a project and the requirements keep changing...") so we can infer something about those dimensions from the answer. Do NOT ask separate questions per dimension; weave them into one scenario. Do NOT use the dimension names or obvious synonyms (e.g. balance, free time, challenge, flexibility) in the scenario or options—the situation and choices should imply them without naming them.

Response format — reply with exactly one JSON object. No markdown, no code fences.
- "completed": false (we are not ending the interview).
- "nextQuestion": object with "title" (string), optional "description", "type" ("single_choice", "multi_choice", or "rank"), "options" (array of {"text": string, "value": string}). For "rank", the user will order the options; do not use maxSelections. Do NOT include "id" — we assign it server-side.
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
  lines.push('Reply with one JSON object: { "completed": false, "nextQuestion": { "title", "description"?, "type", "options" }, "assessmentSummary"?: "..." }. No "id" in nextQuestion.');
  return lines.join('\n');
}

/**
 * Generate one scenario-based question that probes the given dimension set.
 * Question id is NOT returned; the caller assigns it.
 * @param {Array<object>} dimensionSet - [{ dimensionType, dimensionId, name, question_hints, how_measured_or_observed }]
 * @param {string[]} askedQuestionTitles - Titles of questions already asked (for deduplication)
 * @param {Array<object>} answers - Previous answers
 * @param {object} [preSurveyProfile] - Pre-survey profile for tailoring
 * @returns {Promise<{ assessmentSummary?: string, nextQuestion: object | null }>}
 */
async function generateScenarioQuestion(dimensionSet, askedQuestionTitles, answers, preSurveyProfile = null, preferredResponseType = null) {
  const tailoring = buildTailoringBlock(preSurveyProfile);
  const systemContent = getScenarioSystemPrompt() + tailoring;
  const userContent = buildScenarioUserPrompt(dimensionSet, askedQuestionTitles || [], answers, preferredResponseType);

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];

  const content = (await ollamaClient.chat(messages)).content;
  const parsed = parseResponse(content);
  if (!parsed || typeof parsed !== 'object') {
    return { assessmentSummary: null, nextQuestion: null };
  }

  const q = parsed.nextQuestion;
  const qValidation = q ? validateNextQuestionObject(q, true) : { valid: false, errors: ['Missing nextQuestion.'] };
  if (!qValidation.valid) {
    console.warn('[LLM] Scenario question validation failed:', qValidation.errors);
    return { assessmentSummary: parsed.assessmentSummary || null, nextQuestion: null };
  }

  const { id, ...rest } = q;
  return {
    assessmentSummary: parsed.assessmentSummary || null,
    nextQuestion: rest,
  };
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
  buildTailoringBlock,
  validateNextQuestionObject,
};
