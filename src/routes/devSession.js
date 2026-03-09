const router = require('express').Router();
const devSessionController = require('../controllers/devSessionController');

router.get('/export/:sessionId', devSessionController.exportSession);
router.post('/restore', devSessionController.restoreSession);

module.exports = router;
