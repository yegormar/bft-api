'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { bftUserIdMiddleware } = require('../src/middleware/bftUserId');

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('bftUserId middleware', () => {
  it('sets req.bftUserId from valid bft_uid cookie', () => {
    const validUlid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const mw = bftUserIdMiddleware({ nodeEnv: 'development' });
    const req = { headers: { cookie: `bft_uid=${validUlid}` } };
    const res = { cookie: () => {} };
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(req.bftUserId, validUlid);
  });

  it('generates new ULID and sets cookie when bft_uid is missing', () => {
    const mw = bftUserIdMiddleware({ nodeEnv: 'development' });
    const req = { headers: {} };
    let cookieArgs;
    const res = { cookie: (...args) => { cookieArgs = args; } };
    mw(req, res, () => {});
    assert.ok(req.bftUserId);
    assert.match(req.bftUserId, ULID_REGEX);
    assert.strictEqual(cookieArgs[0], 'bft_uid');
    assert.strictEqual(cookieArgs[1], req.bftUserId);
    assert.strictEqual(cookieArgs[2].httpOnly, true);
    assert.strictEqual(cookieArgs[2].sameSite, 'lax');
    assert.strictEqual(cookieArgs[2].secure, false);
  });

  it('generates new ULID when bft_uid is invalid', () => {
    const mw = bftUserIdMiddleware({ nodeEnv: 'development' });
    const req = { headers: { cookie: 'bft_uid=short' } };
    const res = { cookie: (...args) => {} };
    mw(req, res, () => {});
    assert.match(req.bftUserId, ULID_REGEX);
    assert.notStrictEqual(req.bftUserId, 'short');
  });

  it('in production sets sameSite none and secure true when generating', () => {
    const mw = bftUserIdMiddleware({ nodeEnv: 'production' });
    const req = { headers: {} };
    let cookieOptions;
    const res = { cookie: (name, value, options) => { cookieOptions = options; } };
    mw(req, res, () => {});
    assert.strictEqual(cookieOptions.sameSite, 'none');
    assert.strictEqual(cookieOptions.secure, true);
  });

  it('parses cookie when multiple cookies present', () => {
    const validUlid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const req = { headers: { cookie: `other=value; bft_uid=${validUlid}; foo=bar` } };
    const mw = bftUserIdMiddleware({ nodeEnv: 'development' });
    const res = { cookie: () => {} };
    mw(req, res, () => {});
    assert.strictEqual(req.bftUserId, validUlid);
  });
});
