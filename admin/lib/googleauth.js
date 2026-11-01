'use strict';
// "Sign in with Google": checks the ID token (a signed JWT) the browser gets from Google. The signature is checked
// against Google's public keys, then the audience (our own client ID), issuer, expiry and a verified email. Nothing
// else from the token is trusted. The keys are fetched from Google and kept for an hour.

const crypto = require('crypto');
const { ApiError } = require('./http');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const KEY_TTL_MS = 60 * 60 * 1000;
const SKEW_SECONDS = 60;
const FAILED = 'Google sign-in could not be checked. Please try again.';

async function fetchGoogleKeys() {
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Google keys: HTTP ${res.status}`);
  return res.json();
}

const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * A function that takes a Google ID token and returns { sub, email, name }, or throws an ApiError.
 * fetchKeys and now can be replaced in tests.
 */
function makeVerifier({ clientId, fetchKeys = fetchGoogleKeys, now = Date.now } = {}) {
  let cache = { keys: new Map(), at: 0 };

  async function keyFor(kid) {
    if (cache.keys.has(kid) && now() - cache.at < KEY_TTL_MS) return cache.keys.get(kid);
    const jwks = await fetchKeys();
    const keys = new Map();
    for (const k of (jwks && jwks.keys) || []) {
      try { keys.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })); } catch (_) { /* skip a key we cannot read */ }
    }
    cache = { keys, at: now() };
    return keys.get(kid) || null;
  }

  return async function verify(idToken) {
    if (!clientId) throw new ApiError(503, 'Google sign-in is not set up yet.');
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3 || String(idToken).length > 6000) throw new ApiError(400, FAILED);
    let header, claims;
    try { header = decode(parts[0]); claims = decode(parts[1]); } catch (_) { throw new ApiError(400, FAILED); }
    if (header.alg !== 'RS256' || !header.kid) throw new ApiError(401, FAILED);   // never accept "none" or a shared-secret algorithm

    let key;
    try { key = await keyFor(header.kid); } catch (_) { throw new ApiError(503, 'Google could not be reached. Please try again in a minute.'); }
    if (!key) throw new ApiError(401, FAILED);
    const signed = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!signed) throw new ApiError(401, FAILED);

    const nowSeconds = Math.floor(now() / 1000);
    if (!ISSUERS.has(claims.iss) || claims.aud !== clientId) throw new ApiError(401, FAILED);
    if (!(claims.exp > nowSeconds - SKEW_SECONDS)) throw new ApiError(401, 'Google sign-in expired. Please try again.');
    if (!claims.sub || !claims.email) throw new ApiError(401, FAILED);
    if (claims.email_verified !== true && claims.email_verified !== 'true') throw new ApiError(403, 'Your Google email is not verified, so we cannot use it.');
    return { sub: String(claims.sub), email: String(claims.email).trim().toLowerCase(), name: String(claims.name || '').trim() };
  };
}

module.exports = { makeVerifier };
