const router = require('express').Router();
const sessionsController = require('../controllers/sessionsController');
const assessmentsRoutes = require('./assessments');
const reportsRoutes = require('./reports');
const careerPathsRoutes = require('./careerPaths');

router.use('/:sessionId/assessment', assessmentsRoutes);
router.use('/:sessionId/report', reportsRoutes);
router.use('/:sessionId/career-paths', careerPathsRoutes);
router.post('/', sessionsController.create);
router.get('/:id/health', sessionsController.getHealth);
router.get('/:id', sessionsController.getById);
router.patch('/:id', sessionsController.update);

module.exports = router;
