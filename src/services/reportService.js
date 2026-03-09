const assessmentModel = require('../data/assessmentModel');
const { getReportTemplate } = require('../lib/reportStructure');
const assessmentService = require('./assessmentService');
const sessionService = require('./sessionService');
const reportSynthesis = require('../lib/reportSynthesis');
const skillRecommendation = require('../lib/skillRecommendation');

/** Cached synthesized report per session (LLM outputs). Invalidated when answer count changes. */
const reportCacheBySession = new Map();

/** Fields to include in dimension meta for UI modal/short_label. No internal or heavy fields. */
const DIMENSION_META_KEYS = [
  'id',
  'name',
  'short_label',
  'description',
  'ai_future_rationale',
  'how_measured_or_observed',
  'question_hints',
  'score_scale',
];

function pickMeta(dim) {
  if (!dim || typeof dim !== 'object') return null;
  const out = {};
  for (const key of DIMENSION_META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(dim, key)) {
      out[key] = dim[key];
    }
  }
  return out;
}

/**
 * When BFT_DEV_MAX_QUESTIONS is set (short dev path), profileByDimensions.aptitudes
 * may be empty because the interview only asks trait/value questions. For the
 * traits-values page to show all 3 dimension types in dev, fill aptitudes from
 * the model when they are missing.
 */
function ensureDevAptitudesInProfile(profileByDimensions) {
  const devMaxRaw = process.env.BFT_DEV_MAX_QUESTIONS;
  if (devMaxRaw === undefined || devMaxRaw === '') return profileByDimensions;
  const aptitudes = profileByDimensions?.aptitudes;
  if (Array.isArray(aptitudes) && aptitudes.length > 0) return profileByDimensions;
  const model = assessmentModel.load();
  const aptitudesList = model.aptitudes.map((a) => ({ id: a.id, name: a.name }));
  if (aptitudesList.length === 0) return profileByDimensions;
  return {
    ...profileByDimensions,
    aptitudes: aptitudesList,
  };
}

/**
 * Build dimensionMeta for traits, values, and aptitudes present in dimensionScores.
 * Returns { traits: { [id]: meta }, values: { [id]: meta }, aptitudes: { [id]: meta } } for UI lookup.
 */
function buildDimensionMeta(dimensionScores) {
  const out = { traits: {}, values: {}, aptitudes: {} };
  if (!dimensionScores || typeof dimensionScores !== 'object') return out;
  const model = assessmentModel.load();
  const typeToById = {
    traits: model.traitsById,
    values: model.valuesById,
    aptitudes: model.aptitudesById,
  };
  for (const type of ['traits', 'values', 'aptitudes']) {
    const list = dimensionScores[type];
    if (!Array.isArray(list)) continue;
    const byId = typeToById[type];
    if (!byId) continue;
    for (const item of list) {
      const id = item && item.id;
      if (!id) continue;
      const full = byId.get(id);
      const meta = pickMeta(full);
      if (meta) out[type][id] = meta;
    }
  }
  return out;
}

/**
 * When BFT_DEV_MAX_QUESTIONS is set, ensure dimensionScores.aptitudes exists with
 * synthetic scores (same shape as traits/values) so the radar and table show all 3 dimensions.
 */
function ensureDevDimensionScores(dimensionScores) {
  const devMaxRaw = process.env.BFT_DEV_MAX_QUESTIONS;
  if (devMaxRaw === undefined || devMaxRaw === '') return dimensionScores;
  const aptitudes = dimensionScores?.aptitudes;
  if (Array.isArray(aptitudes) && aptitudes.length > 0) return dimensionScores;
  const model = assessmentModel.load();
  if (!model.aptitudes || model.aptitudes.length === 0) return dimensionScores;
  const synthetic = model.aptitudes.map((a) => ({
    id: a.id,
    name: a.name,
    mean: 3,
    band: 'medium',
    count: 1,
  }));
  return {
    ...dimensionScores,
    aptitudes: synthetic,
  };
}

function buildReportFromCache(sessionId, session, assessment, cached) {
  const template = getReportTemplate();
  const report = {
    sessionId,
    status: session.status,
    ...template,
    _meta: { generatedAt: cached.generatedAt, answerCount: assessment.answers.length },
  };
  if (assessment.coverageSummary) report.coverageSummary = assessment.coverageSummary;
  if (assessment.insights) report.insights = assessment.insights;
  report.dimensionScores = ensureDevDimensionScores(assessment.dimensionScores || { traits: [], values: [] });
  report.dimensionMeta = buildDimensionMeta(report.dimensionScores);
  report.profileSummary = cached.profileSummary ?? null;
  report.profileByDimensions = ensureDevAptitudesInProfile(cached.profileByDimensions ?? {});
  report.careerClusterAlignment = null;
  report.skillDevelopmentRoadmap = cached.skillDevelopmentRoadmap ?? null;
  report.structuralDimensionMeta = skillRecommendation.getStructuralDimensionMeta();
  return report;
}

/**
 * Build report from measured data only (no LLM). Used for Traits/Values and Skills pages
 * so they load without triggering narrative or recommendation synthesis.
 */
function buildCoreReport(sessionId, session, assessment) {
  const template = getReportTemplate();
  const report = {
    sessionId,
    status: session.status,
    ...template,
    _meta: { generatedAt: new Date().toISOString(), answerCount: assessment.answers.length },
  };
  if (assessment.coverageSummary) report.coverageSummary = assessment.coverageSummary;
  if (assessment.insights) report.insights = assessment.insights;
  report.dimensionScores = ensureDevDimensionScores(assessment.dimensionScores || { traits: [], values: [] });
  report.dimensionMeta = buildDimensionMeta(report.dimensionScores);
  report.skillDevelopmentRoadmap = skillRecommendation.getSkillsWithApplicability(assessment.dimensionScores || {});
  report.structuralDimensionMeta = skillRecommendation.getStructuralDimensionMeta();

  const coverage = assessment.coverageSummary?.coverage ?? null;
  const profileByDimensions = reportSynthesis.getExploredDimensionsFromCoverage(coverage);
  report.profileByDimensions = ensureDevAptitudesInProfile(profileByDimensions ?? {});

  report.profileSummary = null;
  report.careerClusterAlignment = null;
  return report;
}

/**
 * Get report. When includeLlm is true, runs LLM for profile summary and recommendations
 * (Profile and Recommendations pages). When false or omitted, returns core only (measured
 * dimensions and skills; no LLM). Traits/Values and Skills pages use core only.
 */
async function getReport(sessionId, options = {}) {
  const session = sessionService.getById(sessionId);
  if (!session) return null;
  const assessment = assessmentService.getAssessment(sessionId);
  const answerCount = assessment.answers.length;
  const includeLlm = options.includeLlm === true;

  if (!includeLlm) {
    return buildCoreReport(sessionId, session, assessment);
  }

  const cached = reportCacheBySession.get(sessionId);
  if (cached && cached.answerCount === answerCount) {
    return buildReportFromCache(sessionId, session, assessment, cached);
  }

  const report = buildCoreReport(sessionId, session, assessment);

  const payload = getSessionPayloadForLlm(sessionId);
  const profileSummary = payload
    ? await reportSynthesis.generateProfileSummaryFromPayload(payload)
    : null;
  report.profileSummary = profileSummary ?? null;
  report.profileByDimensions = report.profileByDimensions;

  report.careerClusterAlignment = null;
  report.skillDevelopmentRoadmap = skillRecommendation.getSkillsWithApplicability(assessment.dimensionScores || {});

  reportCacheBySession.set(sessionId, {
    answerCount,
    generatedAt: report._meta.generatedAt,
    profileSummary: report.profileSummary,
    profileByDimensions: report.profileByDimensions,
    skillDevelopmentRoadmap: report.skillDevelopmentRoadmap,
  });

  return report;
}

function invalidateReportCache(sessionId) {
  if (sessionId) reportCacheBySession.delete(sessionId);
}

/** Keys to include for each dimension in the LLM payload (metadata + score). */
const DIMENSION_PAYLOAD_KEYS = [
  'id',
  'name',
  'description',
  'how_measured_or_observed',
  'related_skill_clusters',
  'score_scale',
];

/**
 * Build a single JSON payload representing the session for LLM consumption (assessment summary,
 * profession recommendations). Includes questions/answers, dimension measurements with full metadata,
 * skills with calculated applicability, and personality cluster (pre-survey profile + Q&A).
 *
 * @param {string} sessionId
 * @returns {object | null} Payload object or null if session not found
 */
function getSessionPayloadForLlm(sessionId) {
  const session = sessionService.getById(sessionId);
  if (!session) return null;

  const assessment = assessmentService.getAssessment(sessionId);
  const model = assessmentModel.load();
  const dimensionScores = ensureDevDimensionScores(assessment.dimensionScores || { traits: [], values: [], aptitudes: [] });

  const questions_and_answers = (assessment.askedQuestionsWithAnswers || []).map((q) => ({
    questionId: q.questionId,
    title: q.title,
    description: q.description,
    type: q.type,
    ...(q.prompt != null && { prompt: q.prompt }),
    ...(q.vertices != null && { vertices: q.vertices }),
    ...(q.options != null && { options: q.options }),
    userAnswer: q.userAnswer,
  }));

  const dimensions = { aptitudes: [], traits: [], values: [] };
  for (const type of ['aptitudes', 'traits', 'values']) {
    const list = dimensionScores[type];
    if (!Array.isArray(list)) continue;
    for (const scoreItem of list) {
      const full = model.dimensionsById.get(scoreItem.id);
      const meta = {};
      for (const key of DIMENSION_PAYLOAD_KEYS) {
        if (full && Object.prototype.hasOwnProperty.call(full, key)) {
          meta[key] = full[key];
        }
      }
      dimensions[type].push({
        ...meta,
        id: scoreItem.id,
        name: scoreItem.name ?? full?.name ?? scoreItem.id,
        mean: scoreItem.mean,
        band: scoreItem.band,
        count: scoreItem.count,
      });
    }
  }

  const skillsWithApplicability = skillRecommendation.getSkillsWithApplicability(dimensionScores);
  const skills = skillsWithApplicability.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? '',
    applicability: s.applicability ?? 0,
  }));

  const personality_cluster = {
    pre_survey_profile: session.preSurveyProfile ?? null,
    questions_and_answers_for_profile: questions_and_answers,
  };

  return {
    session_id: sessionId,
    questions_and_answers,
    dimensions,
    skills,
    personality_cluster,
  };
}

module.exports = {
  getReport,
  invalidateReportCache,
  getSessionPayloadForLlm,
};
