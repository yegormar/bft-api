const config = require('../../config');
const assessmentConfig = require('../../config/assessment');
const sessionService = require('./sessionService');
const assessmentModel = require('../data/assessmentModel');
const questionStore = require('./questionStore');
/** Lazy load so scenario/LLM deps are not required when BFT_ASSESSMENT_MODE=triangles. */
function getQuestionGenerator() {
  return require('./questionGeneration');
}

const answersBySession = new Map();
/** Accumulated assessment summaries from Ollama per session (for report). */
const assessmentSummariesBySession = new Map();

/** Per-session interview state: coverage, asked ids/titles, questionToDimension, questionIndex. */
const interviewStateBySession = new Map();

/** Per-session queue of pre-generated questions. Item: { question, dimensionSet, assessmentSummary }. */
const preGeneratedQueueBySession = new Map();

/** Per-session lock: only one background generator runs at a time. */
const generatorBusyBySession = new Map();

const pregenConfig = assessmentConfig.getPregenConfig();
const PREGEN_QUEUE_CAP = pregenConfig.queueCap;
const PREGEN_REFILL_THRESHOLD = pregenConfig.refillThreshold;
if (PREGEN_QUEUE_CAP === 0) {
  console.log('[bft] pregen disabled (BFT_PREGEN_QUEUE_CAP=0)');
} else {
  console.log('[bft] pregen depth queueCap=%s refillThreshold=%s', PREGEN_QUEUE_CAP, PREGEN_REFILL_THRESHOLD);
}

/** Max ms to wait for in-progress background pregen before falling through to store/LLM. */
const PREGEN_WAIT_TIMEOUT_MS = 25000;
const PREGEN_WAIT_POLL_MS = 300;
const storeDir = config.questionsStoreDir;
if (storeDir) {
  console.log('[bft] store enabled dir=%s', storeDir);
} else {
  console.log('[bft] store disabled (BFT_QUESTIONS_STORE_DIR unset)');
}

/** Map dimensionType (singular) to coverage object key (plural) so we read/write the same keys. */
const COVERAGE_KEY_BY_TYPE = { aptitude: 'aptitudes', trait: 'traits', value: 'values', skill: 'skills' };

/** Triangle assessment: score = (barycentric * 4) + 1, mapping [0,1] to [1,5]. */
const TRIANGLE_SCORE_SCALE = { mult: 4, add: 1 };

let trianglesData = null;

function loadTriangles() {
  if (trianglesData) return trianglesData;
  const path = require('path');
  const fs = require('fs');
  const filePath = path.join(__dirname, '..', 'data', 'dimension_triangles.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  trianglesData = JSON.parse(raw);
  return trianglesData;
}

/** Infer dimension type from dimensionId (e.g. value_helping_others_impact -> value). */
function dimensionTypeFromId(dimensionId) {
  if (typeof dimensionId !== 'string') return 'value';
  if (dimensionId.startsWith('value_')) return 'value';
  if (dimensionId.startsWith('trait_')) return 'trait';
  return 'value';
}

/** Build dimensionSet for a triangle from vertices a, b, c (order preserved). */
function triangleToDimensionSet(triangle) {
  const v = triangle.vertices || {};
  return ['a', 'b', 'c'].map((key) => {
    const vert = v[key];
    if (!vert || !vert.dimensionId) return null;
    return {
      dimensionType: dimensionTypeFromId(vert.dimensionId),
      dimensionId: vert.dimensionId,
      id: vert.dimensionId,
    };
  }).filter(Boolean);
}

/** Progress for triangle mode: questionsAsked / total triangles, percentComplete. */
function getTriangleProgress(state, totalTriangles) {
  const questionsAsked = state.questionIndex;
  const percentComplete = totalTriangles > 0 ? Math.round((questionsAsked / totalTriangles) * 100) : 0;
  const model = assessmentModel.load();
  const allDimensions = assessmentModel.getAllDimensions();
  return {
    questionsAsked,
    coveredDimensions: questionsAsked,
    totalDimensions: totalTriangles,
    percentComplete: Math.min(100, percentComplete),
  };
}

/**
 * Get next triangle question when BFT_ASSESSMENT_MODE=triangles.
 * Serves triangles in order; completion when all triangles have been served.
 */
function getNextTriangleQuestion(sessionId) {
  const state = getOrInitInterviewState(sessionId);
  const data = loadTriangles();
  const triangles = data.triangles || [];
  const total = triangles.length;

  if (state.questionIndex >= total) {
    const progress = getTriangleProgress(state, total);
    return {
      completed: true,
      nextQuestion: null,
      assessmentSummary: null,
      progress: { ...progress, percentComplete: 100 },
    };
  }

  const triangle = triangles[state.questionIndex];
  const dimensionSet = triangleToDimensionSet(triangle);
  const question = {
    type: 'triangle',
    id: `triangle_${state.questionIndex}`,
    title: triangle.title,
    prompt: triangle.prompt,
    framing: triangle.framing,
    vertices: {
      a: { label: triangle.vertices?.a?.label, dimensionId: triangle.vertices?.a?.dimensionId },
      b: { label: triangle.vertices?.b?.label, dimensionId: triangle.vertices?.b?.dimensionId },
      c: { label: triangle.vertices?.c?.label, dimensionId: triangle.vertices?.c?.dimensionId },
    },
  };
  const assignedId = `scenario_${state.questionIndex}`;
  state.questionIndex += 1;
  state.askedQuestionIds.add(assignedId);
  state.askedQuestionTitles.push(question.title || '');
  state.questionToDimension[assignedId] = dimensionSet;
  state.servedQuestions[assignedId] = { ...question, id: assignedId };

  for (const d of dimensionSet) {
    const key = COVERAGE_KEY_BY_TYPE[d.dimensionType];
    if (!key) continue;
    const id = d.id;
    if (!state.coverage[key]) state.coverage[key] = {};
    if (!state.coverage[key][id]) state.coverage[key][id] = { questionCount: 0, lastQuestionId: null };
    state.coverage[key][id].questionCount += 1;
    state.coverage[key][id].lastQuestionId = assignedId;
  }

  const progress = getTriangleProgress(state, total);
  return {
    completed: false,
    nextQuestion: { ...question, id: assignedId },
    assessmentSummary: null,
    progress,
  };
}

let devMaxQuestionsLogged = false;

/** Weights for rank order: 1st = 1.0, 2nd = 0.6, 3rd = 0.3; positions 4+ contribute 0. */
const RANK_WEIGHTS = [1, 0.6, 0.3];

function getInterviewConfig() {
  const interviewConfig = assessmentConfig.getInterviewConfig();
  if (interviewConfig.maxQuestions != null && !devMaxQuestionsLogged) {
    devMaxQuestionsLogged = true;
    console.log('[bft] max questions cap active: %s', interviewConfig.maxQuestions);
  }
  return interviewConfig;
}

/** Effective max questions from interview config. */
function getEffectiveMaxQuestions(interviewConfig) {
  return interviewConfig.maxQuestions ?? undefined;
}

function getOrInitInterviewState(sessionId) {
  let state = interviewStateBySession.get(sessionId);
  if (!state) {
    state = {
      askedQuestionIds: new Set(),
      askedQuestionTitles: [],
      questionToDimension: {},
      questionIndex: 0,
      coverage: {
        aptitudes: {},
        traits: {},
        values: {},
        skills: {},
      },
      servedQuestions: {},
      dimensionScoresAggregate: { traits: {}, values: {} },
    };
    interviewStateBySession.set(sessionId, state);
  }
  if (state.servedQuestions == null) state.servedQuestions = {};
  if (state.dimensionScoresAggregate == null) {
    state.dimensionScoresAggregate = { traits: {}, values: {} };
  }
  return state;
}

function isInterviewComplete(coverage, interviewConfig, model, totalQuestionsAsked = 0) {
  const effectiveMax = getEffectiveMaxQuestions(interviewConfig);
  if (effectiveMax != null && totalQuestionsAsked >= effectiveMax) return true;
  const { minSignalPerDimension } = interviewConfig;
  const m = model || assessmentModel.load();
  const types = [
    { key: 'aptitudes', list: m.aptitudes },
    { key: 'traits', list: m.traits },
    { key: 'values', list: m.values },
    { key: 'skills', list: m.skills },
  ];
  for (const { key, list } of types) {
    const cov = coverage[key] || {};
    for (const d of list) {
      const c = cov[d.id];
      const count = c && typeof c.questionCount === 'number' ? c.questionCount : 0;
      if (count < minSignalPerDimension) return false;
    }
  }
  return true;
}

/**
 * Enrich a single dimension with name, description, question_hints, how_measured, score_scale.
 * @param {{ dimensionType: string, dimensionId: string }} d
 * @param {object} [model]
 * @returns {object}
 */
function enrichOneDimension(d, model) {
  const id = d.id;
  const full = assessmentModel.getDimension(d.dimensionType, id);
  const out = {
    dimensionType: d.dimensionType,
    dimensionId: id,
    id,
    name: (full && full.name) || id,
    description: (full && full.description) || '',
    question_hints: (full && full.question_hints) || [],
    how_measured_or_observed: (full && full.how_measured_or_observed) || '',
  };
  if (full && full.score_scale && typeof full.score_scale === 'object') {
    out.score_scale = full.score_scale;
  }
  return out;
}

/**
 * Select one trait or value at random for the next question. Prefers dimensions with minimum coverage so the interview spreads across dimensions.
 * @param {object} coverage - state.coverage
 * @param {object} [model] - loaded assessment model
 * @returns {Array<object>} Array of one enriched dimension (for desiredDimensionSet)
 */
function selectOneDimensionRandom(coverage, model) {
  const m = model || assessmentModel.load();
  const traitsAndValues = [
    ...m.traits.map((t) => ({ dimensionType: 'trait', dimensionId: t.id, id: t.id })),
    ...m.values.map((v) => ({ dimensionType: 'value', dimensionId: v.id, id: v.id })),
  ];
  if (traitsAndValues.length === 0) return [];

  const withCount = traitsAndValues.map((d) => {
    const key = COVERAGE_KEY_BY_TYPE[d.dimensionType];
    const cov = key ? (coverage[key] || {}) : {};
    const c = cov[d.id];
    const questionCount = c && typeof c.questionCount === 'number' ? c.questionCount : 0;
    return { ...d, questionCount };
  });
  const minCount = Math.min(...withCount.map((x) => x.questionCount));
  const withMinCount = withCount.filter((d) => d.questionCount === minCount);
  const chosen = withMinCount[Math.floor(Math.random() * withMinCount.length)];
  return [enrichOneDimension(chosen, m)];
}

function selectNextDimensionSet(coverage, model, options = {}) {
  const m = model || assessmentModel.load();
  const allDimensions = assessmentModel.getAllDimensions();
  const maxDimensions = options.maxDimensions ?? 3;

  const withScore = allDimensions.map((d) => {
    const key = COVERAGE_KEY_BY_TYPE[d.dimensionType];
    const cov = key ? (coverage[key] || {}) : {};
    const c = cov[d.id];
    const questionCount = c && typeof c.questionCount === 'number' ? c.questionCount : 0;
    return { ...d, questionCount };
  });

  withScore.sort((a, b) => a.questionCount - b.questionCount);
  const minCount = withScore[0]?.questionCount ?? 0;
  const withMinCount = withScore.filter((d) => d.questionCount === minCount);
  const selected =
    withMinCount.length <= maxDimensions
      ? withMinCount
      : withMinCount
          .sort(() => Math.random() - 0.5)
          .slice(0, maxDimensions);
  return selected.map((d) => {
    const out = {
      dimensionType: d.dimensionType,
      dimensionId: d.id,
      id: d.id,
      name: d.name,
      question_hints: d.question_hints || [],
      how_measured_or_observed: d.how_measured_or_observed || '',
    };
    if (d.score_scale && typeof d.score_scale === 'object') {
      out.score_scale = d.score_scale;
    }
    return out;
  });
}

/**
 * Compute approximate progress for the interview (for API response and UI).
 * @param {{ coverage, questionIndex }} state - Interview state
 * @param {{ maxQuestions, minSignalPerDimension }} interviewConfig - From getInterviewConfig()
 * @param {object} model - Loaded assessment model
 * @returns {{ questionsAsked, coveredDimensions, totalDimensions, percentComplete }}
 */
function getProgress(state, interviewConfig, model) {
  const effectiveMax = getEffectiveMaxQuestions(interviewConfig);
  const m = model || assessmentModel.load();
  const allDimensions = assessmentModel.getAllDimensions();
  const totalDimensions = allDimensions.length;
  let coveredDimensions = 0;
  const types = [
    { key: 'aptitudes', list: m.aptitudes },
    { key: 'traits', list: m.traits },
    { key: 'values', list: m.values },
    { key: 'skills', list: m.skills },
  ];
  for (const { key, list } of types) {
    const cov = state.coverage[key] || {};
    for (const d of list) {
      const c = cov[d.id];
      if (c && typeof c.questionCount === 'number' && c.questionCount > 0) coveredDimensions += 1;
    }
  }
  const percentComplete = totalDimensions > 0 ? Math.round((coveredDimensions / totalDimensions) * 100) : 0;
  return {
    questionsAsked: state.questionIndex,
    coveredDimensions,
    totalDimensions,
    percentComplete: Math.min(100, percentComplete),
  };
}

/**
 * Apply a served question (from queue, store, or LLM) to session state and optionally mark as used.
 * @param {string} sessionId
 * @param {object} question - { title, description?, type, options }
 * @param {Array<{ dimensionType: string, dimensionId: string }>} dimensionSet
 * @param {string | null} assessmentSummary
 * @param {string | null} bftUserId - if set, mark question as used for this user
 * @returns {{ assignedId: string }}
 */
function applyServedQuestionToState(sessionId, question, dimensionSet, assessmentSummary, bftUserId) {
  const state = getOrInitInterviewState(sessionId);
  const assignedId = `scenario_${state.questionIndex}`;
  state.questionIndex += 1;
  state.askedQuestionIds.add(assignedId);
  state.askedQuestionTitles.push(question.title || '');
  state.questionToDimension[assignedId] = dimensionSet.map((d) => ({
    dimensionType: d.dimensionType,
    dimensionId: d.dimensionId ?? d.id,
    id: d.id ?? d.dimensionId,
  }));
  state.servedQuestions[assignedId] = {
    title: question.title,
    description: question.description,
    type: question.type || 'single_choice',
    options: question.options || [],
  };
  const { coverage } = state;
  for (const dim of dimensionSet) {
    const key = COVERAGE_KEY_BY_TYPE[dim.dimensionType];
    if (!key) continue;
    const id = dim.id;
    if (!coverage[key]) coverage[key] = {};
    if (!coverage[key][id]) coverage[key][id] = { questionCount: 0, lastQuestionId: null };
    coverage[key][id].questionCount += 1;
    coverage[key][id].lastQuestionId = assignedId;
  }
  if (assessmentSummary) {
    const summaries = assessmentSummariesBySession.get(sessionId) || [];
    summaries.push(assessmentSummary);
    assessmentSummariesBySession.set(sessionId, summaries);
  }
  if (bftUserId) {
    const contentHash = questionStore.computeContentHash(question);
    questionStore.markUsed(storeDir, bftUserId, contentHash);
  }
  return { assignedId };
}

/**
 * Get or init the pre-generated queue for a session.
 * @param {string} sessionId
 * @returns {Array<{ question: object, dimensionSet: Array<object>, assessmentSummary: string | null }>}
 */
function getOrInitPreGeneratedQueue(sessionId) {
  let q = preGeneratedQueueBySession.get(sessionId);
  if (!q) {
    q = [];
    preGeneratedQueueBySession.set(sessionId, q);
  }
  return q;
}

function addDimensionScoresToAggregate(aggregate, dims, scoresByDimensionId) {
  if (!aggregate || !dims || !scoresByDimensionId) return;
  for (const dim of dims) {
    if (dim.dimensionType !== 'trait' && dim.dimensionType !== 'value') continue;
    const id = dim.id;
    const score = scoresByDimensionId[id];
    if (score == null || typeof score !== 'number') continue;
    const bucketKey = COVERAGE_KEY_BY_TYPE[dim.dimensionType];
    const bucket = bucketKey ? aggregate[bucketKey] : undefined;
    if (!bucket || typeof bucket !== 'object') continue;
    if (!bucket[id]) bucket[id] = { sum: 0, count: 0 };
    bucket[id].sum += score;
    bucket[id].count += 1;
  }
}

/**
 * Apply a single answer to interview state (coverage + dimensionScoresAggregate).
 * Used by submitAnswers and replaceAnswers.
 */
function applyOneAnswerToState(state, answer, sessionId) {
  const { coverage, questionToDimension, servedQuestions, dimensionScoresAggregate } = state;
  const qid = answer.questionId || answer.question_id;
  if (!qid) return;
  const dims = questionToDimension[qid];
  if (!Array.isArray(dims)) return;
  for (const dim of dims) {
    const key = COVERAGE_KEY_BY_TYPE[dim.dimensionType];
    if (!key) continue;
    const id = dim.id;
    if (!coverage[key]) coverage[key] = {};
    if (!coverage[key][id]) coverage[key][id] = { questionCount: 0, lastQuestionId: null };
    coverage[key][id].questionCount += 1;
    coverage[key][id].lastQuestionId = qid;
  }

  const served = servedQuestions[qid];
  const qType = served?.type || 'single_choice';
  const rawValue = answer.value ?? answer.selected ?? answer.answer ?? answer.text;

  if (qType === 'triangle' && served && dims.length >= 3) {
    const coords = rawValue && typeof rawValue === 'object' ? rawValue : { a: 1 / 3, b: 1 / 3, c: 1 / 3 };
    const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : 1 / 3);
    const a = Math.max(0, Math.min(1, num(coords.a)));
    const b = Math.max(0, Math.min(1, num(coords.b)));
    const c = Math.max(0, Math.min(1, num(coords.c)));
    const sum = a + b + c;
    const na = sum > 0 ? a / sum : 1 / 3;
    const nb = sum > 0 ? b / sum : 1 / 3;
    const nc = sum > 0 ? c / sum : 1 / 3;
    const scoreA = na * TRIANGLE_SCORE_SCALE.mult + TRIANGLE_SCORE_SCALE.add;
    const scoreB = nb * TRIANGLE_SCORE_SCALE.mult + TRIANGLE_SCORE_SCALE.add;
    const scoreC = nc * TRIANGLE_SCORE_SCALE.mult + TRIANGLE_SCORE_SCALE.add;
    const scoresByDimensionId = {
      [dims[0].id]: Math.round(scoreA * 100) / 100,
      [dims[1].id]: Math.round(scoreB * 100) / 100,
      [dims[2].id]: Math.round(scoreC * 100) / 100,
    };
    console.log('[bft] answer sessionId=%s questionId=%s type=triangle barycentric=%s scoresApplied=%s', sessionId, qid, JSON.stringify({ a: na, b: nb, c: nc }), JSON.stringify(scoresByDimensionId));
    addDimensionScoresToAggregate(dimensionScoresAggregate, dims, scoresByDimensionId);
    return;
  }

  if (!served || !Array.isArray(served.options)) return;
  const options = served.options;

  if (qType === 'single_choice' && typeof rawValue === 'string') {
    const option = options.find((o) => o && o.value === rawValue);
    if (option && option.dimensionScores && typeof option.dimensionScores === 'object') {
      console.log('[bft] answer sessionId=%s questionId=%s value=%s optionText=%s scoresApplied=%s', sessionId, qid, rawValue, (option.text || '').slice(0, 60), JSON.stringify(option.dimensionScores));
      addDimensionScoresToAggregate(dimensionScoresAggregate, dims, option.dimensionScores);
    } else if (option && (!option.dimensionScores || typeof option.dimensionScores !== 'object')) {
      console.log('[bft] answer sessionId=%s questionId=%s value=%s optionText=%s (no dimensionScores, coverage only)', sessionId, qid, rawValue, (option.text || '').slice(0, 60));
    }
  } else if (qType === 'multi_choice' && Array.isArray(rawValue)) {
    for (const v of rawValue) {
      const option = options.find((o) => o && o.value === v);
      if (option && option.dimensionScores && typeof option.dimensionScores === 'object') {
        console.log('[bft] answer sessionId=%s questionId=%s value=%s optionText=%s scoresApplied=%s', sessionId, qid, v, (option.text || '').slice(0, 60), JSON.stringify(option.dimensionScores));
        addDimensionScoresToAggregate(dimensionScoresAggregate, dims, option.dimensionScores);
      }
    }
  } else if (qType === 'rank' && Array.isArray(rawValue)) {
    const valueToOption = new Map(options.filter((o) => o && o.value).map((o) => [o.value, o]));
    let weightSum = 0;
    const weightedByDim = {};
    dims.forEach((d) => {
      if (d.dimensionType === 'trait' || d.dimensionType === 'value') weightedByDim[d.id] = { sum: 0, w: 0 };
    });
    rawValue.forEach((v, i) => {
      const w = RANK_WEIGHTS[i] ?? 0;
      if (w <= 0) return;
      const option = valueToOption.get(v);
      if (!option || !option.dimensionScores) return;
      weightSum += w;
      Object.keys(weightedByDim).forEach((dimId) => {
        const s = option.dimensionScores[dimId];
        if (typeof s === 'number') {
          weightedByDim[dimId].sum += w * s;
          weightedByDim[dimId].w += w;
        }
      });
    });
    if (weightSum > 0) {
      const scoresByDimensionId = {};
      Object.keys(weightedByDim).forEach((dimId) => {
        const { sum, w } = weightedByDim[dimId];
        if (w > 0) scoresByDimensionId[dimId] = sum / w;
      });
      console.log('[bft] answer sessionId=%s questionId=%s type=rank order=%s scoresApplied=%s', sessionId, qid, JSON.stringify(rawValue), JSON.stringify(scoresByDimensionId));
      addDimensionScoresToAggregate(dimensionScoresAggregate, dims, scoresByDimensionId);
    }
  }
}

function submitAnswers(sessionId, payload) {
  const existing = answersBySession.get(sessionId) || [];
  const answers = Array.isArray(payload.answers) ? payload.answers : [payload];
  existing.push(...answers);
  answersBySession.set(sessionId, existing);
  console.log('[bft] answers submitted sessionId=%s count=%s total=%s', sessionId, answers.length, existing.length);

  const state = getOrInitInterviewState(sessionId);
  for (const a of answers) {
    applyOneAnswerToState(state, a, sessionId);
  }

  return existing;
}

/**
 * Replace all answers for a session and rebuild coverage/dimension scores.
 * Used when the user changes one or more answers on the "Your answers" page and recalculates.
 * Uses the same scoring logic as submitAnswers (applyOneAnswerToState) so reports and assessment
 * stay consistent. Does NOT advance the interview or trigger question generation (no getNextQuestion,
 * no LLM, no pregen). Only allowed when the session already has the same number of answers (edit
 * after completion).
 * Payload: { answers: [ { questionId, value }, ... ] }
 */
function replaceAnswers(sessionId, payload) {
  const existing = answersBySession.get(sessionId) || [];
  const answers = Array.isArray(payload.answers) ? payload.answers : [];

  if (answers.length === 0) {
    const err = new Error('replaceAnswers requires at least one answer');
    err.status = 400;
    throw err;
  }
  if (existing.length !== answers.length) {
    const err = new Error(
      'replaceAnswers only allowed when payload length matches current answers (edit after completion). ' +
      `Expected ${existing.length}, got ${answers.length}.`
    );
    err.status = 400;
    throw err;
  }

  const state = getOrInitInterviewState(sessionId);
  answersBySession.set(sessionId, answers);
  console.log('[bft] answers replaced sessionId=%s count=%s (no question generation)', sessionId, answers.length);

  state.coverage = {
    aptitudes: {},
    traits: {},
    values: {},
    skills: {},
  };
  state.dimensionScoresAggregate = { traits: {}, values: {} };

  for (const a of answers) {
    applyOneAnswerToState(state, a, sessionId);
  }

  return answers;
}

/**
 * True when the interview has reached the configured question cap (maxQuestions). In that
 * case we fill unmeasured traits/values with synthetic scores so the report is still usable.
 */
function shouldFillUnmeasuredWithSynthetic(state, interviewConfig) {
  if (!state || typeof state.questionIndex !== 'number') return false;
  const effectiveMax = getEffectiveMaxQuestions(interviewConfig);
  if (effectiveMax == null) return false;
  return state.questionIndex >= effectiveMax;
}

/**
 * Random value in [min, max] rounded to 2 decimals. Uses dimension score_scale when present.
 */
function randomScoreInScale(dimension) {
  const scale = dimension && dimension.score_scale && typeof dimension.score_scale === 'object'
    ? dimension.score_scale
    : { min: 1, max: 5 };
  const min = typeof scale.min === 'number' ? scale.min : 1;
  const max = typeof scale.max === 'number' ? scale.max : 5;
  const range = Math.max(0, max - min);
  const value = min + Math.random() * range;
  return Math.round(value * 100) / 100;
}

/**
 * When the interview has reached the question cap, returns an aggregate that includes
 * synthetic scores for all traits/values that have no measured data, so the assessment
 * looks complete. Does not mutate the original aggregate.
 */
function enrichAggregateWithSyntheticUnmeasured(aggregate, state, model, interviewConfig) {
  if (!shouldFillUnmeasuredWithSynthetic(state, interviewConfig)) return aggregate;
  const m = model || assessmentModel.load();
  const out = {
    traits: aggregate && aggregate.traits && typeof aggregate.traits === 'object'
      ? { ...aggregate.traits } : {},
    values: aggregate && aggregate.values && typeof aggregate.values === 'object'
      ? { ...aggregate.values } : {},
  };
  for (const type of ['traits', 'values']) {
    const list = type === 'traits' ? m.traits : m.values;
    const bucket = out[type];
    for (const dim of list) {
      const key = dim.id;
      const entry = bucket[key];
      const hasMeasured = entry && typeof entry.count === 'number' && entry.count >= 1;
      if (!hasMeasured) {
        const score = randomScoreInScale(dim);
        bucket[key] = { sum: score, count: 1 };
      }
    }
  }
  return out;
}

function buildDimensionScoresOutput(aggregate, model) {
  if (!aggregate) return { traits: [], values: [] };
  const m = model || assessmentModel.load();
  const out = { traits: [], values: [] };
  for (const type of ['traits', 'values']) {
    const bucket = aggregate[type];
    if (!bucket || typeof bucket !== 'object') continue;
    const list = type === 'traits' ? m.traits : m.values;
    const dimensionsById = m.dimensionsById;
    for (const id of Object.keys(bucket)) {
      const entry = bucket[id];
      if (!entry || typeof entry.count !== 'number' || entry.count < 1) continue;
      const mean = entry.sum / entry.count;
      const band = mean <= 2 ? 'low' : mean >= 4 ? 'high' : 'medium';
      const dim = dimensionsById.get(id);
      out[type].push({
        id,
        name: (dim && dim.name) || id,
        mean: Math.round(mean * 100) / 100,
        band,
        count: entry.count,
      });
    }
  }
  return out;
}

function getAssessment(sessionId) {
  const answers = answersBySession.get(sessionId) || [];
  const summaries = assessmentSummariesBySession.get(sessionId) || [];
  const state = interviewStateBySession.get(sessionId);
  const coverageSummary = state ? { coverage: state.coverage } : undefined;

  const insights =
    state && Array.isArray(state.askedQuestionTitles)
      ? answers.map((a, i) => ({
          questionId: a.questionId,
          questionTitle: state.askedQuestionTitles[i] ?? null,
          value: a.value ?? a.selected ?? a.answer ?? a.text,
          summary: summaries[i] ?? null,
        }))
      : undefined;

  const interviewConfig = getInterviewConfig();
  const model = assessmentModel.load();
  const effectiveAggregate = state && state.dimensionScoresAggregate
    ? enrichAggregateWithSyntheticUnmeasured(state.dimensionScoresAggregate, state, model, interviewConfig)
    : null;
  const dimensionScores = effectiveAggregate
    ? buildDimensionScoresOutput(effectiveAggregate, model)
    : { traits: [], values: [] };

  let askedQuestionsWithAnswers = undefined;
  if (state && state.servedQuestions && typeof state.questionIndex === 'number') {
    askedQuestionsWithAnswers = [];
    for (let i = 0; i < state.questionIndex; i += 1) {
      const questionId = `scenario_${i}`;
      const served = state.servedQuestions[questionId];
      const userAnswer = answers[i] ? (answers[i].value ?? answers[i].selected ?? answers[i].answer ?? answers[i].text) : undefined;
      if (served) {
        const entry = {
          questionId,
          title: served.title,
          description: served.description,
          type: served.type,
          options: (served.options || []).map((o) => ({
            text: o.text,
            value: o.value,
            dimensionScores: o.dimensionScores,
          })),
          userAnswer,
        };
        if (served.type === 'triangle' && served.vertices) {
          entry.vertices = served.vertices;
          entry.prompt = served.prompt;
        }
        askedQuestionsWithAnswers.push(entry);
      } else {
        askedQuestionsWithAnswers.push({ questionId, userAnswer });
      }
    }
  }

  return {
    sessionId,
    answers,
    assessmentSummaries: summaries,
    coverageSummary,
    insights,
    dimensionScores,
    askedQuestionsWithAnswers,
  };
}

/**
 * Background pre-generation: simulate that the user answered the last question, then generate
 * more questions and push to session queue (and optionally save to store). One runner per session.
 * Uses the question generation component (FIFO, LLM timeout, store fallback).
 * @param {string} sessionId
 * @param {object} lastQuestion - the question just returned to the user
 * @param {Array<object>} lastDimensionSet
 * @param {string} bftUserId - from cookie, for store fallback used-set
 */
function runBackgroundPregeneration(sessionId, lastQuestion, lastDimensionSet, bftUserId) {
  if (process.env.BFT_SKIP_BACKGROUND_PREGEN === '1') return;
  if (PREGEN_QUEUE_CAP === 0) return;
  if (generatorBusyBySession.get(sessionId)) {
    console.log('[bft] background_pregen skipped sessionId=%s (already running)', sessionId);
    return;
  }
  generatorBusyBySession.set(sessionId, true);
  console.log('[bft] background_pregen started sessionId=%s', sessionId);

  const session = sessionService.getById(sessionId);
  if (!session) {
    generatorBusyBySession.set(sessionId, false);
    return;
  }
  const preSurveyProfile = session.preSurveyProfile ?? null;
  const model = assessmentModel.load();
  const interviewConfig = getInterviewConfig();

  (async () => {
    try {
      const answers = answersBySession.get(sessionId) || [];
      const state = getOrInitInterviewState(sessionId);
      const queue = getOrInitPreGeneratedQueue(sessionId);

      const lastSimValue =
        lastQuestion.type === 'rank' && Array.isArray(lastQuestion.options)
          ? lastQuestion.options.map((o) => o.value)
          : lastQuestion.options?.[0]?.value ?? 'placeholder';
      const simulatedAnswers = [
        ...answers,
        { questionId: `scenario_${state.questionIndex - 1}`, value: lastSimValue },
      ];
      const simulatedAskedTitles = [...state.askedQuestionTitles];

      let simulatedCoverage = JSON.parse(JSON.stringify(state.coverage));
      for (const dim of lastDimensionSet) {
        const key = COVERAGE_KEY_BY_TYPE[dim.dimensionType];
        if (!key) continue;
        const id = dim.dimensionId;
        if (!simulatedCoverage[key]) simulatedCoverage[key] = {};
        if (!simulatedCoverage[key][id]) simulatedCoverage[key][id] = { questionCount: 0, lastQuestionId: null };
        simulatedCoverage[key][id].questionCount += 1;
      }

      let simulatedQuestionIndex = state.questionIndex;
      let currentAskedTitles = simulatedAskedTitles;
      let currentAnswers = simulatedAnswers;
      let currentCoverage = simulatedCoverage;

      while (queue.length < PREGEN_QUEUE_CAP) {
        if (isInterviewComplete(currentCoverage, interviewConfig, model, simulatedQuestionIndex)) break;
        const dimensionSet = selectOneDimensionRandom(currentCoverage, model);
        if (dimensionSet.length === 0) break;

        const result = await getQuestionGenerator().requestQuestion({
          sessionId,
          bftUserId: bftUserId || '',
          preSurveyProfile,
          storeDir,
          desiredDimensionSet: dimensionSet,
          askedQuestionTitles: currentAskedTitles,
          answers: currentAnswers,
        });
        const nextQuestion = result?.question;
        const assessmentSummary = result?.assessmentSummary ?? null;
        const dimensionSetForState = result?.dimensionSet ?? dimensionSet;
        if (!nextQuestion || typeof nextQuestion !== 'object' || !nextQuestion.title) break;

        queue.push({ question: nextQuestion, dimensionSet: dimensionSetForState, assessmentSummary });
        if (storeDir && result.source === 'llm') {
          const profileKey = questionStore.getProfileKey(preSurveyProfile);
          questionStore.save(storeDir, profileKey, nextQuestion, dimensionSetForState, assessmentSummary);
        }

        simulatedQuestionIndex += 1;
        currentAskedTitles = [...currentAskedTitles, nextQuestion.title];
        const simValue =
          nextQuestion.type === 'rank' && Array.isArray(nextQuestion.options)
            ? nextQuestion.options.map((o) => o.value)
            : nextQuestion.options?.[0]?.value ?? 'placeholder';
        currentAnswers = [...currentAnswers, { questionId: `scenario_${simulatedQuestionIndex - 1}`, value: simValue }];
        for (const dim of dimensionSetForState) {
          const key = COVERAGE_KEY_BY_TYPE[dim.dimensionType];
          if (!key) continue;
          const id = dim.id;
          if (!currentCoverage[key]) currentCoverage[key] = {};
          if (!currentCoverage[key][id]) currentCoverage[key][id] = { questionCount: 0, lastQuestionId: null };
          currentCoverage[key][id].questionCount += 1;
          currentCoverage[key][id].lastQuestionId = `scenario_${simulatedQuestionIndex - 1}`;
        }
      }
    } catch (err) {
      console.warn('[bft] background_pregen error sessionId=%s err=%s', sessionId, err.message);
    } finally {
      generatorBusyBySession.set(sessionId, false);
      console.log('[bft] background_pregen finished sessionId=%s queueSize=%s', sessionId, getOrInitPreGeneratedQueue(sessionId).length);
    }
  })();
}

/**
 * Wait for in-progress background pregen to push at least one question to the queue, or timeout.
 * @param {string} sessionId
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true if queue has at least one item, false on timeout or when pregen finished with empty queue
 */
async function waitForQueueOrTimeout(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const q = getOrInitPreGeneratedQueue(sessionId);
    if (q.length > 0) return true;
    if (!generatorBusyBySession.get(sessionId)) return false;
    await new Promise((r) => setTimeout(r, PREGEN_WAIT_POLL_MS));
  }
  return false;
}

/**
 * Get next question: session queue first, then (if empty and pregen running) wait for it, then permanent store, then LLM.
 * When returning an LLM question, persists to store and triggers background pre-generation.
 * @param {string} sessionId
 * @param {string} bftUserId - from cookie (req.bftUserId)
 */
async function getNextQuestion(sessionId, bftUserId) {
  if (assessmentConfig.getAssessmentMode() === 'triangles') {
    return getNextTriangleQuestion(sessionId);
  }

  const questionGenerator = getQuestionGenerator();
  const answers = answersBySession.get(sessionId) || [];
  const model = assessmentModel.load();
  const interviewConfig = getInterviewConfig();
  const state = getOrInitInterviewState(sessionId);

  if (isInterviewComplete(state.coverage, interviewConfig, model, state.questionIndex)) {
    const progress = getProgress(state, interviewConfig, model);
    console.log('[bft] assessment complete sessionId=%s questionsAsked=%s', sessionId, state.questionIndex);
    return {
      completed: true,
      nextQuestion: null,
      assessmentSummary: null,
      progress: { ...progress, percentComplete: 100 },
    };
  }

  const session = sessionService.getById(sessionId);
  const preSurveyProfile = session?.preSurveyProfile ?? null;

  let queue = getOrInitPreGeneratedQueue(sessionId);

  if (queue.length > 0) {
    const item = queue.shift();
    const { question, dimensionSet, assessmentSummary } = item;
    const { assignedId } = applyServedQuestionToState(
      sessionId,
      question,
      dimensionSet,
      assessmentSummary,
      bftUserId
    );
    const progress = getProgress(state, interviewConfig, model);
    console.log('[bft] question source=session_queue sessionId=%s questionId=%s queueRemaining=%s', sessionId, assignedId, queue.length);
    if (queue.length < PREGEN_REFILL_THRESHOLD) {
      runBackgroundPregeneration(sessionId, question, dimensionSet, bftUserId);
    }
    return {
      completed: false,
      nextQuestion: { ...question, id: assignedId },
      assessmentSummary: assessmentSummary || null,
      progress,
    };
  }

  if (generatorBusyBySession.get(sessionId)) {
    console.log('[bft] question queue empty but pregen running sessionId=%s waiting up to %sms', sessionId, PREGEN_WAIT_TIMEOUT_MS);
    const gotOne = await waitForQueueOrTimeout(sessionId, PREGEN_WAIT_TIMEOUT_MS);
    queue = getOrInitPreGeneratedQueue(sessionId);
    if (gotOne && queue.length > 0) {
      const item = queue.shift();
      const { question, dimensionSet, assessmentSummary } = item;
      const { assignedId } = applyServedQuestionToState(
        sessionId,
        question,
        dimensionSet,
        assessmentSummary,
        bftUserId
      );
      const progress = getProgress(state, interviewConfig, model);
      console.log('[bft] question source=session_queue sessionId=%s questionId=%s queueRemaining=%s (after wait)', sessionId, assignedId, queue.length);
      if (queue.length < PREGEN_REFILL_THRESHOLD) {
        runBackgroundPregeneration(sessionId, question, dimensionSet, bftUserId);
      }
      return {
        completed: false,
        nextQuestion: { ...question, id: assignedId },
        assessmentSummary: assessmentSummary || null,
        progress,
      };
    }
    if (!gotOne) {
      console.log('[bft] question pregen wait timeout or finished with empty queue sessionId=%s falling through to store/LLM', sessionId);
    }
  }

  const dimensionSet = selectOneDimensionRandom(state.coverage, model);
  if (dimensionSet.length === 0) {
    const progress = getProgress(state, interviewConfig, model);
    return {
      completed: true,
      nextQuestion: null,
      assessmentSummary: null,
      progress: { ...progress, percentComplete: 100 },
    };
  }

  const result = await getQuestionGenerator().requestQuestion({
    sessionId,
    bftUserId,
    preSurveyProfile,
    storeDir,
    desiredDimensionSet: dimensionSet,
    askedQuestionTitles: state.askedQuestionTitles,
    answers,
  });

  let nextQuestion;
  let assessmentSummary = null;
  let dimensionSetForState = dimensionSet;

  if (result && result.question) {
    nextQuestion = result.question;
    assessmentSummary = result.assessmentSummary ?? null;
    dimensionSetForState = result.dimensionSet;
    const { assignedId } = applyServedQuestionToState(
      sessionId,
      nextQuestion,
      dimensionSetForState,
      assessmentSummary,
      bftUserId
    );
    console.log('[bft] question source=%s sessionId=%s questionId=%s', result.source, sessionId, assignedId);
    if (result.source === 'llm' && storeDir) {
      const profileKey = questionStore.getProfileKey(preSurveyProfile);
      questionStore.save(storeDir, profileKey, nextQuestion, dimensionSetForState, assessmentSummary);
    }
    runBackgroundPregeneration(sessionId, nextQuestion, dimensionSetForState, bftUserId);
    const progress = getProgress(getOrInitInterviewState(sessionId), interviewConfig, model);
    return {
      completed: false,
      nextQuestion: { ...nextQuestion, id: assignedId },
      assessmentSummary,
      progress,
    };
  }

  const reason = result && result.reason ? result.reason : 'unknown';
  console.log('[bft] question generator returned null sessionId=%s reason=%s returning serviceUnavailable', sessionId, reason);
  const progress = getProgress(getOrInitInterviewState(sessionId), interviewConfig, model);
  return {
    serviceUnavailable: true,
    message: 'The question service is temporarily unavailable. Your progress has been saved. Please try again in a minute.',
    retryAfterSeconds: 60,
    progress,
  };
}

/**
 * Session health: pre-generated queue size, measured dimensions, progress, coverage, dimension scores, and pregen status.
 * @param {string} sessionId
 * @returns {{ sessionId: string, preGeneratedQuestions: number, questionsAsked: number, answersCount: number, measuredDimensions: object, coverage: object, dimensionScores: object, interviewComplete: boolean, backgroundPregenRunning: boolean } | null} null if session not found
 */
function getSessionHealth(sessionId) {
  const session = sessionService.getById(sessionId);
  if (!session) return null;

  const state = getOrInitInterviewState(sessionId);
  const model = assessmentModel.load();
  const interviewConfig = getInterviewConfig();
  const progress = getProgress(state, interviewConfig, model);

  const types = [
    { key: 'aptitudes', list: model.aptitudes },
    { key: 'traits', list: model.traits },
    { key: 'values', list: model.values },
    { key: 'skills', list: model.skills },
  ];
  const byType = {};
  for (const { key, list } of types) {
    const cov = state.coverage[key] || {};
    let covered = 0;
    for (const d of list) {
      const c = cov[d.id];
      if (c && typeof c.questionCount === 'number' && c.questionCount > 0) covered += 1;
    }
    byType[key] = { covered, total: list.length };
  }

  const queue = getOrInitPreGeneratedQueue(sessionId);
  const answers = answersBySession.get(sessionId) || [];

  const coverage = {};
  for (const { key } of types) {
    coverage[key] = state.coverage[key] || {};
  }

  const effectiveAggregate = enrichAggregateWithSyntheticUnmeasured(
    state.dimensionScoresAggregate,
    state,
    model,
    interviewConfig
  );
  const dimensionScores = buildDimensionScoresOutput(effectiveAggregate, model);

  return {
    sessionId,
    preGeneratedQuestions: queue.length,
    questionsAsked: state.questionIndex,
    answersCount: answers.length,
    measuredDimensions: {
      covered: progress.coveredDimensions,
      total: progress.totalDimensions,
      percentComplete: progress.percentComplete,
      byType,
    },
    coverage,
    dimensionScores,
    interviewComplete: isInterviewComplete(state.coverage, interviewConfig, model, state.questionIndex),
    backgroundPregenRunning: generatorBusyBySession.get(sessionId) === true,
  };
}

module.exports = {
  submitAnswers,
  replaceAnswers,
  getAssessment,
  getNextQuestion,
  getSessionHealth,
  getInterviewConfig,
  isInterviewComplete,
  selectNextDimensionSet,
  getOrInitInterviewState,
};
