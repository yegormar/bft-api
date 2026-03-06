const { getReportTemplate } = require('../lib/reportStructure');
const assessmentService = require('./assessmentService');
const sessionService = require('./sessionService');
const reportSynthesis = require('../lib/reportSynthesis');
const skillRecommendation = require('../lib/skillRecommendation');

/** Cached synthesized report per session (LLM outputs). Invalidated when answer count changes. */
const reportCacheBySession = new Map();

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
  if (assessment.dimensionScores) report.dimensionScores = assessment.dimensionScores;
  report.strengthProfileSummaryLLM = cached.strengthProfileSummaryLLM ?? null;
  report.profileByDimensions = cached.profileByDimensions ?? null;
  report.strengthProfileSummaryHybrid = cached.strengthProfileSummaryHybrid ?? null;
  report.careerClusterAlignment = cached.careerClusterAlignment ?? null;
  report.skillDevelopmentRoadmap = cached.skillDevelopmentRoadmap ?? null;
  report.structuralDimensionMeta = skillRecommendation.getStructuralDimensionMeta();
  return report;
}

async function getReport(sessionId) {
  const session = sessionService.getById(sessionId);
  if (!session) return null;
  const assessment = assessmentService.getAssessment(sessionId);
  const answerCount = assessment.answers.length;

  const cached = reportCacheBySession.get(sessionId);
  if (cached && cached.answerCount === answerCount) {
    return buildReportFromCache(sessionId, session, assessment, cached);
  }

  const template = getReportTemplate();
  const report = {
    sessionId,
    status: session.status,
    ...template,
    _meta: { generatedAt: new Date().toISOString(), answerCount },
  };
  if (assessment.coverageSummary) {
    report.coverageSummary = assessment.coverageSummary;
  }
  if (assessment.insights) {
    report.insights = assessment.insights;
  }
  if (assessment.dimensionScores) {
    report.dimensionScores = assessment.dimensionScores;
  }
  report.skillDevelopmentRoadmap = skillRecommendation.getSkillsWithApplicability(assessment.dimensionScores || {});
  report.structuralDimensionMeta = skillRecommendation.getStructuralDimensionMeta();

  const coverage = assessment.coverageSummary?.coverage ?? null;
  const [strengthProfileSummaryLLM, hybridResult] = await Promise.all([
    reportSynthesis.generateProfileSummaryLLM(assessment.insights, session.preSurveyProfile),
    reportSynthesis.generateProfileSummaryHybrid(coverage),
  ]);
  report.strengthProfileSummaryLLM = strengthProfileSummaryLLM ?? null;
  report.profileByDimensions = hybridResult.profileByDimensions ?? null;
  report.strengthProfileSummaryHybrid = hybridResult.strengthProfileSummaryHybrid ?? null;

  const profileSummaryForRec = strengthProfileSummaryLLM || hybridResult.strengthProfileSummaryHybrid || null;
  const recommendations = await reportSynthesis.generateProfessionRecommendations(
    profileSummaryForRec,
    hybridResult.profileByDimensions,
    session.preSurveyProfile
  );
  report.careerClusterAlignment = recommendations ?? null;

  reportCacheBySession.set(sessionId, {
    answerCount,
    generatedAt: report._meta.generatedAt,
    strengthProfileSummaryLLM: report.strengthProfileSummaryLLM,
    strengthProfileSummaryHybrid: report.strengthProfileSummaryHybrid,
    profileByDimensions: report.profileByDimensions,
    careerClusterAlignment: report.careerClusterAlignment,
    skillDevelopmentRoadmap: report.skillDevelopmentRoadmap,
  });

  return report;
}

module.exports = {
  getReport,
};
