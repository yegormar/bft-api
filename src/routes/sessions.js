const router = require('express').Router();
const sessionsController = require('../controllers/sessionsController');

router.post('/', sessionsController.create);
router.get('/:id', sessionsController.getById);
router.patch('/:id', sessionsController.update);

module.exports = router;
