const router = require('express').Router();
const sessionsRoutes = require('./sessions');
const assessmentsRoutes = require('./assessments');
const reportsRoutes = require('./reports');

router.use('/sessions', sessionsRoutes);
router.use('/sessions/:sessionId/assessment', assessmentsRoutes);
router.use('/sessions/:sessionId/report', reportsRoutes);

module.exports = router;
