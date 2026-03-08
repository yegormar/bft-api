const router = require('express').Router();
const occupationsController = require('../controllers/occupationsController');

router.get('/', occupationsController.listBySkills);
router.get('/:nocCode', occupationsController.getByNocCode);

module.exports = router;
