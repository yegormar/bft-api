function requestLogger(req, res, next) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.originalUrl}`);
  next();
}

module.exports = requestLogger;
