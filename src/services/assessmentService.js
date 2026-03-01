const sessionService = require('./sessionService');
const ollamaClient = require('../lib/ollamaClient');
const ollamaInterview = require('../lib/ollamaInterview');

const answersBySession = new Map();
/** Accumulated assessment summaries from Ollama per session (for report). */
const assessmentSummariesBySession = new Map();

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
  return existing;
}

function getAssessment(sessionId) {
  const answers = answersBySession.get(sessionId) || [];
  const summaries = assessmentSummariesBySession.get(sessionId) || [];
  return { sessionId, answers, assessmentSummaries: summaries };
}

/**
 * Get next question: uses Ollama to assess answers and generate next question when enabled;
 * otherwise falls back to static MAIN_QUESTIONS.
 */
async function getNextQuestion(sessionId) {
  const answers = answersBySession.get(sessionId) || [];
  if (ollamaClient.config.enabled) {
    try {
      const session = sessionService.getById(sessionId);
      const preSurveyProfile = session?.preSurveyProfile ?? null;
      const result = await ollamaInterview.assessAndGetNextQuestion(answers, null, preSurveyProfile);
      const hasValidNext = result.completed === true || (result.nextQuestion && typeof result.nextQuestion === 'object');
      if (!hasValidNext) {
        // LLM returned incomplete/invalid shape (e.g. parse failed) — fall through to static
        console.warn('[assessment] LLM returned no valid next question; falling back to static questions');
      } else {
        if (result.assessmentSummary) {
          const summaries = assessmentSummariesBySession.get(sessionId) || [];
          summaries.push(result.assessmentSummary);
          assessmentSummariesBySession.set(sessionId, summaries);
        }
        return {
          completed: result.completed,
          nextQuestion: result.nextQuestion,
          assessmentSummary: result.assessmentSummary || null,
        };
      }
    } catch (err) {
      console.warn('[assessment] Ollama error, falling back to static questions:', err.message);
    }
  }
  const index = answers.length;
  if (index >= MAIN_QUESTIONS.length) {
    return { completed: true, nextQuestion: null, assessmentSummary: null };
  }
  return {
    completed: false,
    nextQuestion: MAIN_QUESTIONS[index],
    assessmentSummary: null,
  };
}

module.exports = {
  submitAnswers,
  getAssessment,
  getNextQuestion,
};
