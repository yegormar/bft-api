const router = require('express').Router();
const sessionsRoutes = require('./sessions');
const assessmentsRoutes = require('./assessments');
const reportsRoutes = require('./reports');
const occupationsRoutes = require('./occupations');
const feedbackRoutes = require('./feedback');

router.use('/sessions', sessionsRoutes);
router.use('/sessions/:sessionId/assessment', assessmentsRoutes);
router.use('/sessions/:sessionId/report', reportsRoutes);
router.use('/occupations', occupationsRoutes);
router.use('/feedback', feedbackRoutes);

module.exports = router;
