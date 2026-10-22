'use strict';
// The website's Download page: the installers live on GitHub Releases, but the link is never shown on the page.
// The page asks this server, which needs a signed-in customer (a free account is enough), counts the download,
// and hands back the release link. So every download is counted and every downloader has an account.

const { now } = require('./db');
const { ApiError, text } = require('./http');

const TOOLS = [
  { id: 'shortlistprep-ai', name: 'ShortlistPrep.AI', platform: 'Windows 10 and 11',
    description: 'Live help during a real interview: it listens, transcribes and suggests answers based on your own resume.' },
  { id: 'mock-interview', name: 'Mock Interview', platform: 'Windows 10 and 11',
    description: 'Practise with an AI interviewer. Questions are made from your resume, and every answer gets feedback.' },
];
const toolOf = id => TOOLS.find(t => t.id === id);
// a link can also come from the environment, e.g. DOWNLOAD_URL_SHORTLISTPREP_AI / DOWNLOAD_URL_MOCK_INTERVIEW
const envUrl = id => process.env['DOWNLOAD_URL_' + id.toUpperCase().replace(/-/g, '_')] || '';

function addRoutes(ctx) {
  const { add, audit, one, all, db } = ctx;
  const { signedInCustomer } = require('./accounts');

  const fileOf = id => {
    const row = one('SELECT * FROM download_files WHERE tool = ?', id);
    if (row && row.url) return { version: row.version, url: row.url, sizeMb: row.size_mb };
    const url = envUrl(id);
    return url ? { version: '', url, sizeMb: 0 } : null;
  };

  // what the Download page shows (never the link itself)
  add('GET', '/api/downloads', { public: true }, () => ({
    tools: TOOLS.map(t => {
      const f = fileOf(t.id);
      return { id: t.id, name: t.name, platform: t.platform, description: t.description, available: !!f, version: f ? f.version : '', sizeMb: f ? f.sizeMb : 0 };
    }),
  }));

  // a signed-in customer starts a download: it is counted, then the link is returned
  add('POST', '/api/downloads/:tool/start', { public: true }, (req, res, { params }) => {
    const { customer } = signedInCustomer(db, req);
    const tool = toolOf(params.tool);
    if (!tool) throw new ApiError(404, 'That download does not exist');
    const f = fileOf(tool.id);
    if (!f) throw new ApiError(404, `${tool.name} is not ready to download yet. We will email you when it is.`, 'not_ready');
    const at = now();
    db.prepare('INSERT INTO downloads (at, day, tool, version, customer_id) VALUES (?,?,?,?,?)').run(at, at.slice(0, 10), tool.id, f.version, customer.id);
    return { ok: true, url: f.url, version: f.version, name: tool.name };
  });

  // ---- dashboard: counts, and the release link for each tool ----
  add('GET', '/admin/api/downloads', { admin: true }, () => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    return {
      tools: TOOLS.map(t => {
        const f = fileOf(t.id);
        return {
          id: t.id, name: t.name, version: f ? f.version : '', url: f ? f.url : '', sizeMb: f ? f.sizeMb : 0,
          total: one('SELECT COUNT(*) AS n FROM downloads WHERE tool = ?', t.id).n,
          last30: one('SELECT COUNT(*) AS n FROM downloads WHERE tool = ? AND day >= ?', t.id, since).n,
          people: one('SELECT COUNT(DISTINCT customer_id) AS n FROM downloads WHERE tool = ?', t.id).n,
          byDay: all('SELECT day, COUNT(*) AS n FROM downloads WHERE tool = ? AND day >= ? GROUP BY day ORDER BY day', t.id, since),
          byVersion: all('SELECT version, COUNT(*) AS n FROM downloads WHERE tool = ? GROUP BY version ORDER BY n DESC', t.id),
        };
      }),
    };
  });

  add('POST', '/admin/api/downloads/:tool', { admin: true, perm: 'releases.write' }, (req, res, { params, body, admin }) => {
    const tool = toolOf(params.tool);
    if (!tool) throw new ApiError(404, 'Unknown tool');
    const version = text(body.version, 30, { required: true, field: 'Version' });
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new ApiError(400, 'Version must look like 1.2.3');
    const url = text(body.url, 500, { required: true, field: 'Download link' });
    if (!/^https:\/\//i.test(url)) throw new ApiError(400, 'The download link must start with https://');
    const sizeMb = Math.max(0, Math.min(5000, Number(body.sizeMb) || 0));
    db.prepare(`INSERT INTO download_files (tool, version, url, size_mb, updated_at, updated_by) VALUES (?,?,?,?,?,?)
                ON CONFLICT (tool) DO UPDATE SET version = excluded.version, url = excluded.url, size_mb = excluded.size_mb, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(tool.id, version, url, sizeMb, now(), admin.email);
    audit(admin, 'download.set', tool.id, version);
    return { ok: true };
  });
}

module.exports = { addRoutes, TOOLS };
