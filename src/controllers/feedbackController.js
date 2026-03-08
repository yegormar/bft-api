const fs = require('fs');
const path = require('path');

/**
 * Append one feedback entry as a single JSON line to the configured file.
 * BFT_FEEDBACK_FILE is required; startup checks ensure the path is writable.
 */
function persistFeedback(feedbackFilePath, entry) {
  const resolved = path.isAbsolute(feedbackFilePath)
    ? feedbackFilePath
    : path.join(process.cwd(), feedbackFilePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(resolved, line, 'utf8');
}

function create(config) {
  const feedbackFilePath = config.feedbackFile;

  return (req, res, next) => {
    try {
      const rating = req.body?.rating;
      if (rating == null || Number(rating) < 1 || Number(rating) > 5) {
        res.status(400).json({ error: 'rating is required and must be 1 to 5' });
        return;
      }
      const improve = req.body?.improve != null ? String(req.body.improve).trim() : undefined;
      const good = req.body?.good != null ? String(req.body.good).trim() : undefined;

      // Same unique user identity as sessions/assessment (bft_uid cookie set by bftUserIdMiddleware).
      const entry = {
        rating: Number(rating),
        improve: improve || undefined,
        good: good || undefined,
        at: new Date().toISOString(),
        bftUserId: req.bftUserId,
      };

      persistFeedback(feedbackFilePath, entry);

      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { create };
