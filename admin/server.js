#!/usr/bin/env node
'use strict';
// The admin server: the dashboard (static pages), the admin API, and the public licence/website API.
//   npm run admin:create -- you@example.com     (once: creates the first owner and prints a password)
//   npm run admin                               then open http://localhost:4180

const http = require('http');
const fs = require('fs');
const path = require('path');

const { open } = require('./lib/db');
const auth = require('./lib/auth');
const { Signer } = require('./lib/licence');
const { buildRoutes } = require('./lib/routes');
const { ApiError, readJson, sendJson, parseCookies, SECURITY_HEADERS } = require('./lib/http');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function createApp({ dataDir = path.join(__dirname, 'data'), trustProxy = false, secureCookies = false } = {}) {
  const db = open(path.join(dataDir, 'admin.db'));
  const signer = new Signer(dataDir);
  const limiters = {
    login: new auth.Limiter({ max: 5, windowMs: 15 * 60 * 1000 }),
    licence: new auth.Limiter({ max: 60, windowMs: 60 * 1000 }),
    contact: new auth.Limiter({ max: 5, windowMs: 60 * 60 * 1000 }),
  };
  const routes = buildRoutes({ db, signer, limiters });
  const compiled = routes.map(r => ({
    ...r,
    regex: new RegExp('^' + r.pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'),
  }));

  const clientIp = req => {
    if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
  };

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403, SECURITY_HEADERS); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      res.end(data);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin/api/');
    if (!isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY_HEADERS); return res.end(); }
      return serveStatic(req, res, url.pathname);
    }

    // The website and the desktop app call the public API from other origins; it carries no cookies.
    const isPublic = url.pathname.startsWith('/api/');
    const cors = isPublic ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } : {};
    if (req.method === 'OPTIONS') { res.writeHead(isPublic ? 204 : 405, { ...cors, ...SECURITY_HEADERS }); return res.end(); }

    const route = compiled.find(r => r.method === req.method && r.regex.test(url.pathname));
    if (!route) throw new ApiError(404, 'Not found');
    const params = route.regex.exec(url.pathname).groups || {};

    // admin routes: signed in, same-site request, and the role must allow it
    let admin = null;
    const token = parseCookies(req.headers.cookie).sid;
    if (route.options.admin) {
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (req.headers['x-requested-with'] !== 'admin' || (origin && new URL(origin).host !== req.headers.host)) throw new ApiError(403, 'Request blocked');
      }
      if (!route.options.public) {
        admin = auth.getSession(db, token);
        if (!admin) throw new ApiError(401, 'Please sign in');
        if (route.options.perm && !auth.can(admin.role, route.options.perm)) throw new ApiError(403, 'Your role is not allowed to do that');
      }
    }

    const body = req.method === 'GET' ? {} : await readJson(req);
    const result = await route.handler(req, res, { params, body, query: url.searchParams, admin, token, ip: clientIp(req) });

    const headers = { ...cors, ...SECURITY_HEADERS };
    if (result && result.cookie) {
      headers['Set-Cookie'] = `sid=${result.cookie.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${result.cookie.maxAgeSeconds}${secureCookies ? '; Secure' : ''}`;
    } else if (result && result.clearCookie) {
      headers['Set-Cookie'] = `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}`;
    }
    const status = (result && result.status) || 200;
    const payload = result && result.body !== undefined ? result.body : result;
    sendJson(res, status, payload, headers);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (res.headersSent) return res.end();
      if (err instanceof ApiError) return sendJson(res, err.status, { ok: false, error: err.message, code: err.code }, SECURITY_HEADERS);
      if (err && err.status) return sendJson(res, err.status, { ok: false, error: err.message }, SECURITY_HEADERS);
      console.error('Unexpected error:', err);
      sendJson(res, 500, { ok: false, error: 'Something went wrong on the server' }, SECURITY_HEADERS);
    });
  });

  return { server, db, signer, limiters, close: () => new Promise(resolve => server.close(() => { db.close(); resolve(); })) };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 4180;
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp({
    dataDir: process.env.ADMIN_DATA_DIR || undefined,
    trustProxy: process.env.TRUST_PROXY === '1',
    secureCookies: process.env.SECURE_COOKIES === '1',
  });
  const owners = app.db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'owner' AND disabled = 0").get().n;
  app.server.listen(port, host, () => {
    console.log(`Admin dashboard: http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`);
    if (!owners) console.log('No admin account yet. Create the first owner with:  npm run admin:create -- you@example.com');
  });
}

module.exports = { createApp };
