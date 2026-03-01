const sessionService = require('../services/sessionService');
const reportService = require('../services/reportService');

async function getReport(req, res, next) {
  try {
    const { sessionId } = req.params;
    if (!sessionService.getById(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const report = await reportService.getReport(sessionId);
    res.json(report);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getReport,
};
