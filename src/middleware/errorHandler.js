function errorHandler(err, req, res, next) {
  const status = err.status ?? err.statusCode ?? 500;
  const message = err.message ?? 'Internal server error';
  const payload = { error: message };
  if (process.env.NODE_ENV === 'development' && err.stack) {
    payload.stack = err.stack;
  }
  res.status(status).json(payload);
}

module.exports = errorHandler;
