const router = require('express').Router();
const configController = require('../controllers/configController');

router.get('/', configController.getConfig);

module.exports = router;
