const sessionService = require('../services/sessionService');
const reportService = require('../services/reportService');

async function getReport(req, res, next) {
  try {
    const { sessionId } = req.params;
    if (!sessionService.getById(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const includeLlm = req.query.include === 'full';
    const report = await reportService.getReport(sessionId, { includeLlm });
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.json(report);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /sessions/:sessionId/report/payload
 * Returns a single JSON object representing the session for LLM submission (assessment summary,
 * profession recommendations). Includes questions/answers, dimension measurements with metadata,
 * skills with applicability scores, and personality cluster (pre-survey profile + Q&A).
 */
function getPayload(req, res, next) {
  try {
    const { sessionId } = req.params;
    if (!sessionService.getById(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const payload = reportService.getSessionPayloadForLlm(sessionId);
    if (!payload) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getReport,
  getPayload,
};
