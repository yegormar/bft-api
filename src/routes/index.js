const router = require('express').Router();
const sessionsRoutes = require('./sessions');
const assessmentsRoutes = require('./assessments');
const reportsRoutes = require('./reports');
const careerPathsRoutes = require('./careerPaths');
const occupationsRoutes = require('./occupations');
const feedbackRoutes = require('./feedback');
const configRoutes = require('./config');

router.use('/sessions', sessionsRoutes);
router.use('/occupations', occupationsRoutes);
router.use('/feedback', feedbackRoutes);
router.use('/config', configRoutes);

module.exports = router;
