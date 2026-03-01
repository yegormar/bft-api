const router = require('express').Router({ mergeParams: true });
const reportsController = require('../controllers/reportsController');

router.get('/', reportsController.getReport);

module.exports = router;
