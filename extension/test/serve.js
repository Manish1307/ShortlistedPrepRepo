'use strict';
// Serves the extension folder on http://localhost:5189 so the mock portal (test/mock-portal.html) can be opened in a browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', types[path.extname(file)] || 'text/plain');
  res.end(fs.readFileSync(file));
}).listen(5189, () => console.log('Mock portal: http://localhost:5189/test/mock-portal.html'));
