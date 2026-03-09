const router = require('express').Router({ mergeParams: true });
const reportsController = require('../controllers/reportsController');

router.get('/', reportsController.getReport);
router.get('/payload', reportsController.getPayload);

module.exports = router;
