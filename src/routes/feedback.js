const router = require('express').Router();
const config = require('../../config');
const feedbackController = require('../controllers/feedbackController');

router.post('/', feedbackController.create({ feedbackFile: config.feedbackFile }));

module.exports = router;
