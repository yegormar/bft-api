const sessionService = require('../services/sessionService');
const assessmentService = require('../services/assessmentService');

function submitAnswers(req, res, next) {
  try {
    const { sessionId } = req.params;
    if (!sessionService.getById(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const answers = assessmentService.submitAnswers(sessionId, req.body);
    res.status(201).json({ sessionId, answers });
  } catch (err) {
    next(err);
  }
}

function getAssessment(req, res, next) {
  try {
    const { sessionId } = req.params;
    if (!sessionService.getById(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const assessment = assessmentService.getAssessment(sessionId);
    res.json(assessment);
  } catch (err) {
    next(err);
  }
}

async function getNextQuestion(req, res, next) {
  try {
    const { sessionId } = req.params;
    if (!sessionService.getById(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const result = await assessmentService.getNextQuestion(sessionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  submitAnswers,
  getAssessment,
  getNextQuestion,
};
