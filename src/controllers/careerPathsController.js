const config = require('../../config');
const sessionService = require('../services/sessionService');
const careerPathsSynthesis = require('../lib/careerPathsSynthesis');

/**
 * POST /api/sessions/:sessionId/career-paths
 * Body: { skills: [ { id: string, bucket: 'high'|'medium'|'low' } ] } (time-investment buckets; high = user will invest a lot).
 * Returns { paths: [ { study, initialJob, ultimateJob, rationale? } ] }
 */
async function postCareerPaths(req, res, next) {
  try {
    const { sessionId } = req.params;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim() === '') {
      res.status(400).json({ error: 'sessionId is required.' });
      return;
    }

    if (!sessionService.getById(sessionId)) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }

    const body = req.body || {};
    const skillsRaw = Array.isArray(body.skills) ? body.skills : [];
    const skills = skillsRaw
      .filter((s) => s && typeof s.id === 'string' && s.id.trim() !== '')
      .map((s) => ({ id: String(s.id).trim(), bucket: s.bucket }));

    const result = await careerPathsSynthesis.generateCareerPaths(sessionId, skills);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.json(result);
  } catch (err) {
    if (err.message && (err.message.includes('not valid JSON') || err.message.includes('no valid paths'))) {
      res.status(502).json({ error: err.message });
      return;
    }
    if (err.message && (err.message.includes('bucket') || err.message.includes('high, medium, low'))) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err.message && err.message.includes('Session not found')) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err.message && err.message.includes('LLM is not configured')) {
      res.status(503).json({ error: err.message });
      return;
    }
    next(err);
  }
}

module.exports = {
  postCareerPaths,
};
