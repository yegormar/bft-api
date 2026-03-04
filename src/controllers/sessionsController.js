const sessionService = require('../services/sessionService');
const assessmentService = require('../services/assessmentService');

function create(req, res, next) {
  try {
    const preSurveyProfile = req.body?.preSurveyProfile ?? null;
    const clientId = req.body?.id ?? null;
    const session = sessionService.create(preSurveyProfile, clientId);
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
}

function getById(req, res, next) {
  try {
    const session = sessionService.getById(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    next(err);
  }
}

function update(req, res, next) {
  try {
    const session = sessionService.update(req.params.id, req.body);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    next(err);
  }
}

function getHealth(req, res, next) {
  try {
    const sessionId = req.params.id;
    if (!sessionService.getById(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const health = assessmentService.getSessionHealth(sessionId);
    if (!health) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(health);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  create,
  getById,
  update,
  getHealth,
};
