/**
 * Ensures req.bftUserId is set from cookie bft_uid (or generates and sets it).
 * Used for per-user "already used questions" and persistent identity across sessions.
 */
const { ulid } = require('ulid');

const COOKIE_NAME = 'bft_uid';
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function parseCookie(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  header.split(';').forEach((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) out[key] = value;
  });
  return out;
}

function isValidUlid(value) {
  return typeof value === 'string' && ULID_REGEX.test(value);
}

/**
 * @param {{ nodeEnv: string }} config - App config (nodeEnv for cookie options)
 */
function bftUserIdMiddleware(config) {
  return (req, res, next) => {
    const cookies = parseCookie(req.headers.cookie);
    let uid = cookies[COOKIE_NAME];
    if (!uid || !isValidUlid(uid)) {
      uid = ulid();
      const isProduction = config.nodeEnv === 'production';
      res.cookie(COOKIE_NAME, uid, {
        httpOnly: true,
        maxAge: ONE_YEAR_MS,
        sameSite: isProduction ? 'none' : 'lax',
        secure: isProduction,
      });
      console.log('[bft] cookie new bft_uid=%s', uid);
    }
    req.bftUserId = uid;
    next();
  };
}

module.exports = { bftUserIdMiddleware };