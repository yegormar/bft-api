const config = require('../../config');
const sessionService = require('./sessionService');
const assessmentModel = require('../data/assessmentModel');
const questionStore = require('./questionStore');
const questionGenerator = require('./questionGeneration');

/** Scenario batches (traits/values) for batch-based question selection. Loaded once. */
let scenarioBatchesData = null;
function getScenarioBatches() {
  if (scenarioBatchesData) return scenarioBatchesData;
  try {
    const data = require('../data/scenarioBatches.json');
    scenarioBatchesData = {
      batches: Array.isArray(data.batches) ? data.batches : [],
      constraints: data.constraints || {},
    };
    return scenarioBatchesData;
  } catch {
    scenarioBatchesData = { batches: [], constraints: {} };
    return scenarioBatchesData;
  }
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

function getPregenConfig() {
  const capRaw = process.env.BFT_PREGEN_QUEUE_CAP;
  const cap = capRaw !== undefined && capRaw !== '' ? parseInt(capRaw, 10) : 5;
  const refillRaw = process.env.BFT_PREGEN_REFILL_THRESHOLD;
  const refill = refillRaw !== undefined && refillRaw !== '' ? parseInt(refillRaw, 10) : 1;
  const queueCap = Number.isNaN(cap) || cap < 0 ? 5 : cap;
  const refillThreshold = Number.isNaN(refill) || refill < 0 ? 1 : Math.min(refill, Math.max(0, queueCap - 1));
  return { queueCap, refillThreshold };
}

const pregenConfig = getPregenConfig();
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

let devMaxQuestionsLogged = false;

/** Weights for rank order: 1st = 1.0, 2nd = 0.6, 3rd = 0.3; positions 4+ contribute 0. */
const RANK_WEIGHTS = [1, 0.6, 0.3];

function getInterviewConfig() {
  const minRaw = process.env.MIN_SIGNAL_PER_DIMENSION;
  const minSignal = minRaw !== undefined && minRaw !== '' ? parseInt(minRaw, 10) : 1;
  let maxQuestions;
  if (config.nodeEnv === 'development') {
    const devMaxRaw = process.env.BFT_DEV_MAX_QUESTIONS;
    if (devMaxRaw !== undefined && devMaxRaw !== '') {
      const devMax = parseInt(devMaxRaw, 10);
      if (!Number.isNaN(devMax) && devMax >= 1) {
        maxQuestions = devMax;
        if (!devMaxQuestionsLogged) {
          devMaxQuestionsLogged = true;
          console.log('[bft] dev max questions cap active: %s', maxQuestions);
        }
      }
    }
  }
  if (maxQuestions == null) {
    const maxRaw = process.env.MAX_INTERVIEW_QUESTIONS;
    maxQuestions = maxRaw !== undefined && maxRaw !== '' ? parseInt(maxRaw, 10) : undefined;
  }
  return { minSignalPerDimension: minSignal, maxQuestions };
}

/** Effective max questions: from config, or from scenario batch constraints when using batches. */
function getEffectiveMaxQuestions(config) {
  if (config.maxQuestions != null) return config.maxQuestions;
  const { batches, constraints } = getScenarioBatches();
  if (batches.length > 0 && typeof constraints.maxQuestionsPerInterview === 'number') {
    return constraints.maxQuestionsPerInterview;
  }
  return undefined;
}

function getOrInitInterviewState(sessionId) {
  let state = interviewStateBySession.get(sessionId);
  if (!state) {
    state = {
      askedQuestionIds: new Set(),
      askedQuestionTitles: [],
      questionToDimension: {},
      questionIndex: 0,
      usedBatchIds: [],
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

function isInterviewComplete(coverage, config, model, totalQuestionsAsked = 0) {
  const effectiveMax = getEffectiveMaxQuestions(config);
  if (effectiveMax != null && totalQuestionsAsked >= effectiveMax) return true;
  const { batches } = getScenarioBatches();
  if (batches.length > 0) {
    return false;
  }
  const { minSignalPerDimension } = config;
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

/** Enrich a batch's dimensions with name, description, question_hints, how_measured, score_scale from assessment model. */
function enrichBatchDimensionSet(batch, model) {
  const m = model || assessmentModel.load();
  return (batch.dimensions || []).map((d) => {
    const full = assessmentModel.getDimension(d.dimensionType, d.dimensionId);
    const out = {
      dimensionType: d.dimensionType,
      dimensionId: d.dimensionId,
      name: (full && full.name) || d.dimensionId,
      description: (full && full.description) || '',
      question_hints: (full && full.question_hints) || [],
      how_measured_or_observed: (full && full.how_measured_or_observed) || '',
    };
    if (full && full.score_scale && typeof full.score_scale === 'object') {
      out.score_scale = full.score_scale;
    }
    return out;
  });
}

/**
 * Select next batch for scenario: prefer least-used batches, then by least coverage of batch dimensions.
 * @returns {{ batchId: string, dimensionSet: Array<object>, preferredResponseType?: string } | null}
 */
function selectNextBatch(state, model) {
  const { batches } = getScenarioBatches();
  if (!batches.length) return null;
  const m = model || assessmentModel.load();
  const usedCount = (id) => (state.usedBatchIds || []).filter((bid) => bid === id).length;
  const coverageScore = (batch) => {
    const dims = batch.dimensions || [];
    let sum = 0;
    for (const d of dims) {
      const key = COVERAGE_KEY_BY_TYPE[d.dimensionType];
      const cov = key ? (state.coverage[key] || {}) : {};
      const c = cov[d.dimensionId];
      sum += (c && c.questionCount) || 0;
    }
    return sum;
  };
  const sorted = [...batches].sort((a, b) => {
    const useA = usedCount(a.id);
    const useB = usedCount(b.id);
    if (useA !== useB) return useA - useB;
    return coverageScore(a) - coverageScore(b);
  });
  const batch = sorted[0];
  if (!batch) return null;
  const dimensionSet = enrichBatchDimensionSet(batch, m);
  if (dimensionSet.length === 0) return null;
  return {
    batchId: batch.id,
    dimensionSet,
    preferredResponseType: batch.preferredResponseType,
    batchTheme: batch.theme ?? null,
    dilemmaAnchor: batch.dilemmaAnchor ?? null,
  };
}

function selectNextDimensionSet(coverage, model, options = {}) {
  const m = model || assessmentModel.load();
  const allDimensions = assessmentModel.getAllDimensions();
  const maxDimensions = options.maxDimensions ?? 3;

  const withScore = allDimensions.map((d) => {
    const key = COVERAGE_KEY_BY_TYPE[d.dimensionType];
    const cov = key ? (coverage[key] || {}) : {};
    const c = cov[d.dimensionId];
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
      dimensionId: d.dimensionId,
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
 * When using scenario batches, totalDimensions = effective max questions and percentComplete is question-based.
 * @param {{ coverage, questionIndex, usedBatchIds }} state - Interview state
 * @param {{ maxQuestions }} config - Interview config
 * @param {object} model - Loaded assessment model
 * @returns {{ questionsAsked, coveredDimensions, totalDimensions, percentComplete }}
 */
function getProgress(state, config, model) {
  const effectiveMax = getEffectiveMaxQuestions(config);
  const { batches } = getScenarioBatches();

  if (batches.length > 0 && effectiveMax != null) {
    const questionsAsked = state.questionIndex;
    const totalDimensions = effectiveMax;
    const percentComplete = totalDimensions > 0 ? Math.round((questionsAsked / totalDimensions) * 100) : 0;
    return {
      questionsAsked,
      coveredDimensions: questionsAsked,
      totalDimensions,
      percentComplete: Math.min(100, percentComplete),
    };
  }

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
 * @param {string | null} [batchId] - if set (batch-based flow), record batch as used
 * @returns {{ assignedId: string }}
 */
function applyServedQuestionToState(sessionId, question, dimensionSet, assessmentSummary, bftUserId, batchId = null) {
  const state = getOrInitInterviewState(sessionId);
  const assignedId = `scenario_${state.questionIndex}`;
  state.questionIndex += 1;
  state.askedQuestionIds.add(assignedId);
  state.askedQuestionTitles.push(question.title || '');
  state.questionToDimension[assignedId] = dimensionSet.map((d) => ({
    dimensionType: d.dimensionType,
    dimensionId: d.dimensionId,
  }));
  state.servedQuestions[assignedId] = {
    title: question.title,
    description: question.description,
    type: question.type || 'single_choice',
    options: question.options || [],
  };
  if (batchId) {
    if (!state.usedBatchIds) state.usedBatchIds = [];
    state.usedBatchIds.push(batchId);
  }
  const { coverage } = state;
  for (const dim of dimensionSet) {
    const key = COVERAGE_KEY_BY_TYPE[dim.dimensionType];
    if (!key) continue;
    const id = dim.dimensionId;
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

const MAIN_QUESTIONS = [
  {
    id: 'main_1',
    title: 'When facing a new problem, what do you usually do first?',
    description: 'Pick the option that fits you best.',
    type: 'single_choice',
    options: [
      { text: 'Break it down into steps and plan', value: 'structured' },
      { text: 'Try something quickly and see what happens', value: 'experimental' },
      { text: 'Talk it through with others', value: 'social' },
      { text: 'Research or look for similar examples', value: 'research' },
    ],
  },
  {
    id: 'main_2',
    title: 'What kind of work environment do you prefer?',
    description: 'Select up to two.',
    type: 'multi_choice',
    maxSelections: 2,
    options: [
      { text: 'Clear goals and deadlines', value: 'structured' },
      { text: 'Freedom to explore and experiment', value: 'creative' },
      { text: 'Working with a team', value: 'social' },
      { text: 'Independent, focused work', value: 'independent' },
    ],
  },
  {
    id: 'main_3',
    title: 'How do you feel about learning something completely new?',
    type: 'single_choice',
    options: [
      { text: 'I enjoy it and look for new challenges', value: 'adventurous' },
      { text: 'I prefer to build on what I already know', value: 'structured' },
      { text: 'It depends on the topic and how useful it is', value: 'pragmatic' },
    ],
  },
];

function addDimensionScoresToAggregate(aggregate, dims, scoresByDimensionId) {
  if (!aggregate || !dims || !scoresByDimensionId) return;
  for (const dim of dims) {
    if (dim.dimensionType !== 'trait' && dim.dimensionType !== 'value') continue;
    const score = scoresByDimensionId[dim.dimensionId];
    if (score == null || typeof score !== 'number') continue;
    const bucketKey = COVERAGE_KEY_BY_TYPE[dim.dimensionType];
    const bucket = bucketKey ? aggregate[bucketKey] : undefined;
    if (!bucket || typeof bucket !== 'object') continue;
    if (!bucket[dim.dimensionId]) bucket[dim.dimensionId] = { sum: 0, count: 0 };
    bucket[dim.dimensionId].sum += score;
    bucket[dim.dimensionId].count += 1;
  }
}

function submitAnswers(sessionId, payload) {
  const existing = answersBySession.get(sessionId) || [];
  const answers = Array.isArray(payload.answers) ? payload.answers : [payload];
  existing.push(...answers);
  answersBySession.set(sessionId, existing);
  console.log('[bft] answers submitted sessionId=%s count=%s total=%s', sessionId, answers.length, existing.length);

  const state = getOrInitInterviewState(sessionId);
  const { coverage, questionToDimension, servedQuestions, dimensionScoresAggregate } = state;
  for (const a of answers) {
    const qid = a.questionId || a.question_id;
    if (!qid) continue;
    const dims = questionToDimension[qid];
    if (!Array.isArray(dims)) continue;
    for (const dim of dims) {
      const key = COVERAGE_KEY_BY_TYPE[dim.dimensionType];
      if (!key) continue;
      const id = dim.dimensionId;
      if (!coverage[key]) coverage[key] = {};
      if (!coverage[key][id]) coverage[key][id] = { questionCount: 0, lastQuestionId: null };
      coverage[key][id].questionCount += 1;
      coverage[key][id].lastQuestionId = qid;
    }

    const served = servedQuestions[qid];
    if (!served || !Array.isArray(served.options)) continue;
    const options = served.options;
    const qType = served.type || 'single_choice';
    const rawValue = a.value ?? a.selected ?? a.answer ?? a.text;

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
        if (d.dimensionType === 'trait' || d.dimensionType === 'value') weightedByDim[d.dimensionId] = { sum: 0, w: 0 };
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

  return existing;
}

function buildDimensionScoresOutput(aggregate, model) {
  if (!aggregate) return { traits: [], values: [] };
  const m = model || assessmentModel.load();
  const out = { traits: [], values: [] };
  for (const type of ['traits', 'values']) {
    const bucket = aggregate[type];
    if (!bucket || typeof bucket !== 'object') continue;
    const list = type === 'traits' ? m.traits : m.values;
    const byId = type === 'traits' ? m.traitsById : m.valuesById;
    for (const dimensionId of Object.keys(bucket)) {
      const entry = bucket[dimensionId];
      if (!entry || typeof entry.count !== 'number' || entry.count < 1) continue;
      const mean = entry.sum / entry.count;
      const band = mean <= 2 ? 'low' : mean >= 4 ? 'high' : 'medium';
      const dim = byId.get(dimensionId);
      out[type].push({
        id: dimensionId,
        name: (dim && dim.name) || dimensionId,
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

  const dimensionScores = state && state.dimensionScoresAggregate
    ? buildDimensionScoresOutput(state.dimensionScoresAggregate)
    : { traits: [], values: [] };

  let askedQuestionsWithAnswers = undefined;
  if (state && state.servedQuestions && typeof state.questionIndex === 'number') {
    askedQuestionsWithAnswers = [];
    for (let i = 0; i < state.questionIndex; i += 1) {
      const questionId = `scenario_${i}`;
      const served = state.servedQuestions[questionId];
      const userAnswer = answers[i] ? (answers[i].value ?? answers[i].selected ?? answers[i].answer ?? answers[i].text) : undefined;
      if (served) {
        askedQuestionsWithAnswers.push({
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
        });
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
      let simulatedUsedBatchIds = [...(state.usedBatchIds || [])];
      const { batches } = getScenarioBatches();

      while (queue.length < PREGEN_QUEUE_CAP) {
        if (isInterviewComplete(currentCoverage, interviewConfig, model, simulatedQuestionIndex)) break;
        const simulatedState = {
          coverage: currentCoverage,
          questionIndex: simulatedQuestionIndex,
          usedBatchIds: simulatedUsedBatchIds,
        };
        const batchSelection = batches.length > 0 ? selectNextBatch(simulatedState, model) : null;
        const dimensionSet = batchSelection
          ? batchSelection.dimensionSet
          : selectNextDimensionSet(currentCoverage, model, { maxDimensions: 3 });
        const preferredResponseType = batchSelection ? batchSelection.preferredResponseType : null;
        const batchId = batchSelection ? batchSelection.batchId : null;

        const result = await questionGenerator.requestQuestion({
          sessionId,
          bftUserId: bftUserId || '',
          preSurveyProfile,
          storeDir,
          desiredDimensionSet: dimensionSet,
          askedQuestionTitles: currentAskedTitles,
          answers: currentAnswers,
          preferredResponseType,
          batchTheme: batchSelection?.batchTheme ?? null,
          dilemmaAnchor: batchSelection?.dilemmaAnchor ?? null,
        });
        const nextQuestion = result?.question;
        const assessmentSummary = result?.assessmentSummary ?? null;
        const dimensionSetForState = result?.dimensionSet ?? dimensionSet;
        if (!nextQuestion || typeof nextQuestion !== 'object' || !nextQuestion.title) break;

        queue.push({ question: nextQuestion, dimensionSet: dimensionSetForState, assessmentSummary, batchId });
        if (storeDir && result.source === 'llm') {
          const profileKey = questionStore.getProfileKey(preSurveyProfile);
          questionStore.save(storeDir, profileKey, nextQuestion, dimensionSetForState, assessmentSummary);
        }

        simulatedQuestionIndex += 1;
        if (batchId) simulatedUsedBatchIds.push(batchId);
        currentAskedTitles = [...currentAskedTitles, nextQuestion.title];
        const simValue =
          nextQuestion.type === 'rank' && Array.isArray(nextQuestion.options)
            ? nextQuestion.options.map((o) => o.value)
            : nextQuestion.options?.[0]?.value ?? 'placeholder';
        currentAnswers = [...currentAnswers, { questionId: `scenario_${simulatedQuestionIndex - 1}`, value: simValue }];
        for (const dim of dimensionSetForState) {
          const key = COVERAGE_KEY_BY_TYPE[dim.dimensionType];
          if (!key) continue;
          const id = dim.dimensionId;
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
    const { question, dimensionSet, assessmentSummary, batchId } = item;
    const { assignedId } = applyServedQuestionToState(
      sessionId,
      question,
      dimensionSet,
      assessmentSummary,
      bftUserId,
      batchId || null
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
      const { question, dimensionSet, assessmentSummary, batchId } = item;
      const { assignedId } = applyServedQuestionToState(
        sessionId,
        question,
        dimensionSet,
        assessmentSummary,
        bftUserId,
        batchId || null
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

  const { batches } = getScenarioBatches();
  const batchSelection = batches.length > 0 ? selectNextBatch(state, model) : null;
  const dimensionSet = batchSelection
    ? batchSelection.dimensionSet
    : selectNextDimensionSet(state.coverage, model, { maxDimensions: 3 });
  const preferredResponseType = batchSelection ? batchSelection.preferredResponseType : null;
  const batchId = batchSelection ? batchSelection.batchId : null;

  const result = await questionGenerator.requestQuestion({
    sessionId,
    bftUserId,
    preSurveyProfile,
    storeDir,
    desiredDimensionSet: dimensionSet,
    askedQuestionTitles: state.askedQuestionTitles,
    answers,
    preferredResponseType,
    batchTheme: batchSelection?.batchTheme ?? null,
    dilemmaAnchor: batchSelection?.dilemmaAnchor ?? null,
  });

  let nextQuestion;
  let assessmentSummary = null;
  let dimensionSetForState = dimensionSet;

  if (result) {
    nextQuestion = result.question;
    assessmentSummary = result.assessmentSummary ?? null;
    dimensionSetForState = result.dimensionSet;
    const { assignedId } = applyServedQuestionToState(
      sessionId,
      nextQuestion,
      dimensionSetForState,
      assessmentSummary,
      bftUserId,
      batchId
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

  const fallbackIndex = state.questionIndex % MAIN_QUESTIONS.length;
  const fallback = MAIN_QUESTIONS[fallbackIndex];
  nextQuestion = {
    title: fallback.title,
    description: fallback.description,
    type: fallback.type,
    options: fallback.options,
    maxSelections: fallback.maxSelections,
  };
  console.log('[bft] question source=fallback sessionId=%s (component returned null)', sessionId);
  const { assignedId } = applyServedQuestionToState(
    sessionId,
    nextQuestion,
    dimensionSetForState,
    null,
    bftUserId,
    batchId
  );
  if (storeDir) {
    const profileKey = questionStore.getProfileKey(preSurveyProfile);
    questionStore.save(storeDir, profileKey, nextQuestion, dimensionSetForState, null);
  }
  runBackgroundPregeneration(sessionId, nextQuestion, dimensionSetForState, bftUserId);
  const progress = getProgress(getOrInitInterviewState(sessionId), interviewConfig, model);
  return {
    completed: false,
    nextQuestion: { ...nextQuestion, id: assignedId },
    assessmentSummary: null,
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

  const dimensionScores = buildDimensionScoresOutput(state.dimensionScoresAggregate, model);

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
  getAssessment,
  getNextQuestion,
  getSessionHealth,
  getInterviewConfig,
  isInterviewComplete,
  selectNextDimensionSet,
  getOrInitInterviewState,
};
