const sessionService = require('./sessionService');
const ollamaClient = require('../lib/ollamaClient');
const ollamaInterview = require('../lib/ollamaInterview');
const assessmentModel = require('../data/assessmentModel');

const answersBySession = new Map();
/** Accumulated assessment summaries from Ollama per session (for report). */
const assessmentSummariesBySession = new Map();

/** Per-session interview state: coverage, asked ids/titles, questionToDimension, questionIndex. */
const interviewStateBySession = new Map();

/** Map dimensionType (singular) to coverage object key (plural) so we read/write the same keys. */
const COVERAGE_KEY_BY_TYPE = { aptitude: 'aptitudes', trait: 'traits', value: 'values', skill: 'skills' };

function getInterviewConfig() {
  const minRaw = process.env.MIN_SIGNAL_PER_DIMENSION;
  const minSignal = minRaw !== undefined && minRaw !== '' ? parseInt(minRaw, 10) : 1;
  const maxRaw = process.env.MAX_INTERVIEW_QUESTIONS;
  const maxQuestions = maxRaw !== undefined && maxRaw !== '' ? parseInt(maxRaw, 10) : undefined;
  return { minSignalPerDimension: minSignal, maxQuestions };
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
    };
    interviewStateBySession.set(sessionId, state);
  }
  return state;
}

function isInterviewComplete(coverage, config, model, totalQuestionsAsked = 0) {
  const { minSignalPerDimension, maxQuestions } = config;
  const m = model || assessmentModel.load();
  if (maxQuestions != null && totalQuestionsAsked >= maxQuestions) return true;
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
  return selected.map((d) => ({
    dimensionType: d.dimensionType,
    dimensionId: d.dimensionId,
    name: d.name,
    question_hints: d.question_hints || [],
    how_measured_or_observed: d.how_measured_or_observed || '',
  }));
}

/**
 * Compute approximate progress for the interview (for API response and UI).
 * @param {{ coverage, questionIndex }} state - Interview state
 * @param {{ maxQuestions }} config - Interview config
 * @param {object} model - Loaded assessment model
 * @returns {{ questionsAsked, coveredDimensions, totalDimensions, percentComplete, estimatedTotalQuestions }}
 */
function getProgress(state, config, model) {
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
  const questionsAsked = state.questionIndex;

  return {
    questionsAsked,
    coveredDimensions,
    totalDimensions,
    percentComplete: Math.min(100, percentComplete),
  };
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

function submitAnswers(sessionId, payload) {
  const existing = answersBySession.get(sessionId) || [];
  const answers = Array.isArray(payload.answers) ? payload.answers : [payload];
  existing.push(...answers);
  answersBySession.set(sessionId, existing);

  const state = getOrInitInterviewState(sessionId);
  const { coverage, questionToDimension } = state;
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
  }

  return existing;
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

  return { sessionId, answers, assessmentSummaries: summaries, coverageSummary, insights };
}

/**
 * Get next question: uses assessment model, coverage, and LLM to generate scenario-based
 * questions that probe multiple dimensions. Question id is assigned in code.
 */
async function getNextQuestion(sessionId) {
  const answers = answersBySession.get(sessionId) || [];
  const model = assessmentModel.load();
  const config = getInterviewConfig();
  const state = getOrInitInterviewState(sessionId);

  if (isInterviewComplete(state.coverage, config, model, state.questionIndex)) {
    const progress = getProgress(state, config, model);
    return {
      completed: true,
      nextQuestion: null,
      assessmentSummary: null,
      progress: { ...progress, percentComplete: 100 },
    };
  }

  const dimensionSet = selectNextDimensionSet(state.coverage, model, { maxDimensions: 3 });
  const session = sessionService.getById(sessionId);
  const preSurveyProfile = session?.preSurveyProfile ?? null;

  let nextQuestion = null;
  let assessmentSummary = null;

  if (ollamaClient.config.enabled) {
    try {
      const result = await ollamaInterview.generateScenarioQuestion(
        dimensionSet,
        state.askedQuestionTitles,
        answers,
        preSurveyProfile
      );
      if (result.nextQuestion && typeof result.nextQuestion === 'object') {
        nextQuestion = result.nextQuestion;
        assessmentSummary = result.assessmentSummary || null;
      }
    } catch (err) {
      console.warn('[assessment] LLM scenario generation error, using fallback:', err.message);
    }
  }

  if (!nextQuestion || typeof nextQuestion !== 'object' || !nextQuestion.title) {
    const fallbackIndex = state.questionIndex % MAIN_QUESTIONS.length;
    const fallback = MAIN_QUESTIONS[fallbackIndex];
    nextQuestion = {
      title: fallback.title,
      description: fallback.description,
      type: fallback.type,
      options: fallback.options,
      maxSelections: fallback.maxSelections,
    };
  }

  const assignedId = `scenario_${state.questionIndex}`;
  state.questionIndex += 1;
  state.askedQuestionIds.add(assignedId);
  state.askedQuestionTitles.push(nextQuestion.title || '');
  state.questionToDimension[assignedId] = dimensionSet.map((d) => ({
    dimensionType: d.dimensionType,
    dimensionId: d.dimensionId,
  }));

  if (assessmentSummary) {
    const summaries = assessmentSummariesBySession.get(sessionId) || [];
    summaries.push(assessmentSummary);
    assessmentSummariesBySession.set(sessionId, summaries);
  }

  const progress = getProgress(state, config, model);

  return {
    completed: false,
    nextQuestion: { ...nextQuestion, id: assignedId },
    assessmentSummary,
    progress,
  };
}

module.exports = {
  submitAnswers,
  getAssessment,
  getNextQuestion,
  getInterviewConfig,
  isInterviewComplete,
  selectNextDimensionSet,
  getOrInitInterviewState,
};
