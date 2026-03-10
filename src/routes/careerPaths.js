const router = require('express').Router({ mergeParams: true });
const careerPathsController = require('../controllers/careerPathsController');

router.post('/', careerPathsController.postCareerPaths);

module.exports = router;
