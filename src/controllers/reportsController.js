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

module.exports = {
  getReport,
};
