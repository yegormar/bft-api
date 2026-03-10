const path = require('path');
const fs = require('fs');
const assessmentModel = require('../data/assessmentModel');
const { getReportTemplate } = require('../lib/reportStructure');
const assessmentService = require('./assessmentService');
const sessionService = require('./sessionService');
const reportSynthesis = require('../lib/reportSynthesis');
const skillRecommendation = require('../lib/skillRecommendation');

/** Lazy-loaded map: triangleId -> { answer_interpretations: { balanced?, dominant_a?, ... } } */
let triangleInterpretationsById = null;
function getTriangleInterpretationsById() {
  if (triangleInterpretationsById) return triangleInterpretationsById;
  const basePath = path.join(__dirname, '..', 'data');
  const files = ['dimension_triangles.json', 'dimension_triangles_aptitudes.json'];
  triangleInterpretationsById = {};
  for (const file of files) {
    const filePath = path.join(basePath, file);
    if (!fs.existsSync(filePath)) continue;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const triangles = data.triangles || [];
    for (const t of triangles) {
      if (t.id && t.answer_interpretations && typeof t.answer_interpretations === 'object') {
        triangleInterpretationsById[t.id] = t.answer_interpretations;
      }
    }
  }
  return triangleInterpretationsById;
}

/**
 * Infer pattern from barycentric userAnswer: "balanced" if no strong pull, else "dominant_a" etc.
 * @param {{ a?: number, b?: number, c?: number }} userAnswer
 * @returns {'balanced'|'dominant_a'|'dominant_b'|'dominant_c'}
 */
function getTriangleAnswerPattern(userAnswer) {
  if (!userAnswer || typeof userAnswer !== 'object') return 'balanced';
  const a = Number(userAnswer.a);
  const b = Number(userAnswer.b);
  const c = Number(userAnswer.c);
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c)) return 'balanced';
  const max = Math.max(a, b, c);
  const min = Math.min(a, b, c);
  if (max - min <= 0.25 || max <= 0.45) return 'balanced';
  if (a === max) return 'dominant_a';
  if (b === max) return 'dominant_b';
  return 'dominant_c';
}

/**
 * Get interpretation text for a triangle answer. Uses answer_interpretations from data when
 * present; otherwise returns a short fallback based on pattern and vertices.
 */
function getInterpretationForTriangleAnswer(triangleId, userAnswer, vertices, interpretationsById) {
  const pattern = getTriangleAnswerPattern(userAnswer);
  const interpretations = interpretationsById && triangleId ? interpretationsById[triangleId] : null;
  const text = interpretations && interpretations[pattern];
  if (text && typeof text === 'string') return text;
  if (pattern === 'balanced') return 'All three options feel somewhat relevant; no strong pull in any direction. This question is one input to your profile.';
  const key = pattern === 'dominant_a' ? 'a' : pattern === 'dominant_b' ? 'b' : 'c';
  const label = vertices && vertices[key] && vertices[key].label ? vertices[key].label : key;
  return `Strongest pull toward: ${label}.`;
}

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
 * @param {{ includeQuestionsAndAnswers?: boolean }} [options] - If includeQuestionsAndAnswers is false, omit questions_and_answers (e.g. for career paths so the model uses only dimensions + skills).
 * @returns {object | null} Payload object or null if session not found
 */
function getSessionPayloadForLlm(sessionId, options = {}) {
  const session = sessionService.getById(sessionId);
  if (!session) return null;

  const assessment = assessmentService.getAssessment(sessionId);
  const model = assessmentModel.load();
  const dimensionScores = ensureDevDimensionScores(assessment.dimensionScores || { traits: [], values: [], aptitudes: [] });

  const includeQa = options.includeQuestionsAndAnswers !== false;
  const questions_and_answers = includeQa
    ? (assessment.askedQuestionsWithAnswers || []).map((q) => {
    const base = {
      title: q.title,
      type: q.type,
      ...(q.prompt != null && { prompt: q.prompt }),
      ...(q.vertices != null && { vertices: q.vertices }),
    };
    if (q.type === 'triangle' && q.userAnswer != null && typeof q.userAnswer === 'object') {
      const ua = q.userAnswer;
      const pa = Math.round((Number(ua.a) || 0) * 100);
      const pb = Math.round((Number(ua.b) || 0) * 100);
      const pc = Math.round((Number(ua.c) || 0) * 100);
      const nameFor = (key) => {
        const v = q.vertices && q.vertices[key];
        const id = v && v.dimensionId;
        const dim = id ? model.dimensionsById.get(id) : null;
        return (dim && dim.name) || id || key;
      };
      base.choiceSummary = `Position: ${nameFor('a')} ${pa}%, ${nameFor('b')} ${pb}%, ${nameFor('c')} ${pc}%`;
      const pattern = getTriangleAnswerPattern(q.userAnswer);
      const dominantKey = pattern === 'dominant_a' ? 'a' : pattern === 'dominant_b' ? 'b' : pattern === 'dominant_c' ? 'c' : null;
      if (dominantKey && q.vertices && q.vertices[dominantKey] && typeof q.vertices[dominantKey].label === 'string') {
        base.chosenOptionLabel = q.vertices[dominantKey].label;
      }
    } else if (q.userAnswer !== undefined) {
      base.userAnswer = q.userAnswer;
    }
    return base;
  })
    : undefined;

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
      const band = scoreItem.band;
      const scale = full && full.score_scale && full.score_scale.interpretation;
      const band_interpretation =
        band && scale && typeof scale[band] === 'string' ? scale[band] : undefined;
      dimensions[type].push({
        ...meta,
        id: scoreItem.id,
        name: scoreItem.name ?? full?.name ?? scoreItem.id,
        mean: scoreItem.mean,
        band,
        count: scoreItem.count,
        ...(band_interpretation != null && { band_interpretation }),
      });
    }
  }

  const skillsWithApplicability = skillRecommendation.getSkillsWithApplicability(dimensionScores);
  const skills = skillsWithApplicability.map((s) => {
    const full = model.skillsById.get(s.id);
    const out = {
      id: s.id,
      name: s.name,
      description: s.description ?? '',
      applicability: s.applicability ?? 0,
    };
    if (full && typeof full.ai_trend === 'string' && full.ai_trend.length > 0) {
      out.ai_trend = full.ai_trend;
    }
    return out;
  });

  const personality_cluster = {
    pre_survey_profile: session.preSurveyProfile ?? null,
  };

  const payload = {
    session_id: sessionId,
    dimensions,
    skills,
    personality_cluster,
  };
  if (questions_and_answers !== undefined) {
    payload.questions_and_answers = questions_and_answers;
  }
  return payload;
}

module.exports = {
  getReport,
  invalidateReportCache,
  getSessionPayloadForLlm,
};
