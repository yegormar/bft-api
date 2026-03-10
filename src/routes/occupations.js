const router = require('express').Router();
const occupationsController = require('../controllers/occupationsController');

router.get('/', occupationsController.listBySkills);
router.post('/match', occupationsController.matchBySkillsAndDimensions);
router.get('/:nocCode', occupationsController.getByNocCode);

module.exports = router;
