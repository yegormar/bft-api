const express = require('express');
const cors = require('cors');
const routes = require('./src/routes');
const notFound = require('./src/middleware/notFound');
const errorHandler = require('./src/middleware/errorHandler');
const requestLogger = require('./src/middleware/requestLogger');

function createApp(config) {
  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json());
  app.use(requestLogger);

  app.use('/api', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
