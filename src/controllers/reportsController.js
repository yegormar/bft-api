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
    res.json(report);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getReport,
};
