const sessionService = require('../services/sessionService');
const assessmentService = require('../services/assessmentService');
const reportService = require('../services/reportService');

/**
 * GET /api/dev/session/export/:sessionId
 * Export full session state (questions, answers, interview state) for dev/debug. Not part of UI.
 */
function exportSession(req, res, next) {
  try {
    const { sessionId } = req.params;
    if (!sessionService.getById(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const data = assessmentService.exportSessionData(sessionId);
    if (!data) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/dev/session/restore
 * Body: { export: <exported blob>, targetSessionId?: string }
 * Restore session from export. Optionally use targetSessionId to restore under a new id.
 */
function restoreSession(req, res, next) {
  try {
    const payload = req.body?.export ?? req.body;
    const targetSessionId = req.body?.targetSessionId;
    const { sessionId, session } = assessmentService.restoreSessionData(payload, targetSessionId);
    reportService.invalidateReportCache(sessionId);
    res.status(201).json({ sessionId, session });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  exportSession,
  restoreSession,
};
