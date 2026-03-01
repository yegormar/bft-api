const { getReportTemplate } = require('../lib/reportStructure');
const assessmentService = require('./assessmentService');
const sessionService = require('./sessionService');

function getReport(sessionId) {
  const session = sessionService.getById(sessionId);
  if (!session) return null;
  const assessment = assessmentService.getAssessment(sessionId);
  const template = getReportTemplate();
  return {
    sessionId,
    status: session.status,
    ...template,
    _meta: { generatedAt: new Date().toISOString(), answerCount: assessment.answers.length },
  };
}

module.exports = {
  getReport,
};
