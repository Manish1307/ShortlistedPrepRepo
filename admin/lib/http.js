'use strict';
// Small HTTP helpers shared by the server and the routes.

class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const MAX_BODY = 100 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiError(413, 'Request is too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch (_) { reject(new ApiError(400, 'The request body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

// ---- small validators used by the routes ----
const text = (value, max, { required = false, field = 'Value' } = {}) => {
  const s = String(value === undefined || value === null ? '' : value).trim();
  if (required && !s) throw new ApiError(400, `${field} is required`);
  if (s.length > max) throw new ApiError(400, `${field} is too long (maximum ${max} characters)`);
  return s;
};
const email = value => {
  const s = text(value, 200, { required: true, field: 'Email' }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new ApiError(400, 'That email address does not look right');
  return s;
};
const integer = (value, { min = 0, max = 1e9, field = 'Number' } = {}) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, `${field} must be a whole number from ${min} to ${max}`);
  return n;
};
const likeTerm = q => `%${String(q || '').trim().replace(/[\\%_]/g, m => '\\' + m)}%`;

module.exports = { ApiError, readJson, sendJson, parseCookies, SECURITY_HEADERS, text, email, integer, likeTerm };
