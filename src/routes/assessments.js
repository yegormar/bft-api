const router = require('express').Router({ mergeParams: true });
const assessmentsController = require('../controllers/assessmentsController');

router.post('/answers', assessmentsController.submitAnswers);
router.get('/next', assessmentsController.getNextQuestion);
router.get('/', assessmentsController.getAssessment);

module.exports = router;
