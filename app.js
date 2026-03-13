const path = require('path');
const express = require('express');
const cors = require('cors');
const routes = require('./src/routes');
const notFound = require('./src/middleware/notFound');
const errorHandler = require('./src/middleware/errorHandler');
const requestLogger = require('./src/middleware/requestLogger');
const { bftUserIdMiddleware } = require('./src/middleware/bftUserId');

function createApp(config) {
  const app = express();

  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json());
  app.use(requestLogger);

  app.get('/', (req, res) => {
    res.json({ ok: true, message: 'bft-api. Use /api/sessions, /api/admin/scenarios/stats (when BFT_ADMIN_ENABLED=1), etc.' });
  });

  app.use('/api', bftUserIdMiddleware(config));
  app.use('/api', routes);

  if (process.env.BFT_ADMIN_ENABLED === '1') {
    app.use('/api/admin', require('./src/routes/admin'));
    app.get('/admin', (req, res) => {
      res.sendFile(path.join(__dirname, '..', 'bft-doc', 'admin', 'scenario-admin.html'));
    });
  }

  const sessionExportFlag = (process.env.BFT_DEV_SESSION_EXPORT || '1').trim().toLowerCase();
  if (sessionExportFlag !== '0' && sessionExportFlag !== 'false') {
    app.use('/api/dev/session', require('./src/routes/devSession'));
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
