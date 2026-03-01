const { ulid } = require('ulid');

const sessions = new Map();

const STATUSES = ['draft', 'in_progress', 'completed'];

/** ULID format: 26 chars, Crockford base32 (0-9, A-Z excluding I,L,O,U). */
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isValidUlid(value) {
  return typeof value === 'string' && ULID_REGEX.test(value);
}

function create(preSurveyProfile = null, clientId = null) {
  const id = clientId && isValidUlid(clientId) ? clientId : ulid();
  const session = {
    id,
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    preSurveyProfile: preSurveyProfile ?? undefined,
  };
  sessions.set(id, session);
  if (preSurveyProfile) {
    console.log('[session] Pre-survey profile for session', id, JSON.stringify(preSurveyProfile, null, 2));
  }
  return session;
}

function getById(id) {
  return sessions.get(id) ?? null;
}

function update(id, updates) {
  const session = sessions.get(id);
  if (!session) return null;
  if (updates.status && STATUSES.includes(updates.status)) {
    session.status = updates.status;
  }
  session.updatedAt = new Date().toISOString();
  return session;
}

module.exports = {
  create,
  getById,
  update,
};
