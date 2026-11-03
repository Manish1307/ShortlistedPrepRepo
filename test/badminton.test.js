'use strict';
// Badminton tournaments: the rules and the draw (no database), then the admin API and the keyword-protected live page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../admin/server');
const { hashPassword } = require('../admin/lib/auth');
const bd = require('../admin/lib/badminton');

const RULES = { pointsToWin: 21, winBy: 2, pointCap: 30, gamesToWin: 2 };

// ---------------------------------------------------------------- rules

test('a game: 21 points and 2 clear, deuce goes on, and the first to 30 wins', () => {
  const w = (a, b) => bd.gameWinner(a, b, RULES);
  assert.equal(w(21, 10), 'a');
  assert.equal(w(10, 21), 'b');
  assert.equal(w(21, 19), 'a');
  assert.equal(w(21, 20), '', 'only one clear: play on');
  assert.equal(w(20, 20), '');
  assert.equal(w(22, 20), 'a');
  assert.equal(w(22, 21), '');
  assert.equal(w(29, 29), '', 'one point from the cap');
  assert.equal(w(30, 29), 'a', 'the cap decides it');
  assert.equal(w(29, 30), 'b');
  assert.equal(w(20, 15), '', 'not at 21 yet');
});

test('a match is the best of three: the first to two games', () => {
  assert.deepEqual(bd.matchState([{ a: 21, b: 5 }], RULES), { a: 1, b: 0, winner: '' });
  assert.equal(bd.matchState([{ a: 21, b: 5 }, { a: 21, b: 9 }], RULES).winner, 'a');
  assert.equal(bd.matchState([{ a: 21, b: 5 }, { a: 8, b: 21 }, { a: 18, b: 21 }], RULES).winner, 'b');
  assert.equal(bd.matchState([{ a: 21, b: 5 }, { a: 8, b: 21 }, { a: 10, b: 10 }], RULES).winner, '', 'a third game in progress');
  assert.equal(bd.matchState([{ a: 21, b: 5 }], { ...RULES, gamesToWin: 1 }).winner, 'a', 'a single-game match');
});

test('the team draw uses every player once and balances the levels', () => {
  const players = Array.from({ length: 12 }, (_, i) => ({ name: 'P' + i, level: 1 + (i % 5) }));
  const teams = bd.drawTeams(players, 3);
  assert.equal(teams.length, 3);
  assert.deepEqual(teams.map(t => t.length), [4, 4, 4]);
  assert.deepEqual(teams.flat().map(p => p.name).sort(), players.map(p => p.name).sort());
  const sums = teams.map(t => t.reduce((n, p) => n + p.level, 0));
  assert.ok(Math.max(...sums) - Math.min(...sums) <= 3, 'balanced: ' + sums);
  // not always the same teams
  const again = new Set();
  for (let i = 0; i < 20; i++) again.add(bd.drawTeams(players, 3).map(t => t.map(p => p.name).sort().join()).sort().join('|'));
  assert.ok(again.size > 1, 'the draw is random');
});

test('round robin: everyone plays everyone once, nobody twice in a round, odd teams get a bye', () => {
  for (const n of [2, 3, 4, 5, 6, 8]) {
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const rounds = bd.roundRobin(ids);
    const pairs = rounds.flat().map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join('-'));
    assert.equal(new Set(pairs).size, n * (n - 1) / 2, `${n} teams: every pair once`);
    assert.equal(pairs.length, n * (n - 1) / 2);
    for (const r of rounds) { const seen = r.flat(); assert.equal(new Set(seen).size, seen.length, `${n} teams: a team plays once a round`); }
  }
  assert.equal(bd.roundRobin([1, 2, 3, 4], 2).flat().length, 12, 'two legs');
});

test('courts and times: no team twice in a slot, no more matches than courts', () => {
  const items = [];
  const ties = bd.roundRobin([1, 2, 3, 4, 5, 6]);
  ties.forEach(r => r.forEach(([a, b]) => ['S', 'D', 'M'].forEach(k => items.push({ teamA: a, teamB: b, kind: k }))));
  bd.assignSlots(items, 3);
  const bySlot = new Map();
  for (const it of items) (bySlot.get(it.slot) || bySlot.set(it.slot, []).get(it.slot)).push(it);
  for (const list of bySlot.values()) {
    assert.ok(list.length <= 3, 'at most 3 courts');
    assert.equal(new Set(list.map(i => i.court)).size, list.length, 'one match a court');
    const teams = list.flatMap(i => [i.teamA, i.teamB]);
    assert.equal(new Set(teams).size, teams.length, 'a team plays once in a slot');
  }
  assert.ok(items.every(i => i.court >= 1 && i.court <= 3));
});

test('keywords are matched without caring about case or extra spaces', () => {
  assert.equal(bd.normKeyword('  Friday   SMASH '), 'friday smash');
  assert.ok(bd.KEYWORD.test('friday-smash'));
  assert.ok(!bd.KEYWORD.test('abc'), 'too short');
  assert.ok(!bd.KEYWORD.test('<script>'));
});

// ---------------------------------------------------------------- API

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function start() {
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bd-')) });
  const base = await listen(app.server);
  const mk = (email, role) => app.db.prepare("INSERT INTO admins (email, name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, datetime('now'))").run(email, role, role, hashPassword('correct-horse-battery'));
  mk('boss@example.com', 'owner');
  mk('helper@example.com', 'support');
  const jar = { cookie: '' };
  const call = async (method, url, body, admin = false) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(admin ? { 'X-Requested-With': 'admin', Cookie: jar.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) jar.cookie = set.split(';')[0];
    return { status: r.status, json: await r.json() };
  };
  const login = email => call('POST', '/admin/api/login', { email, password: 'correct-horse-battery' }, true);
  await login('boss@example.com');
  const a = (method, url, body) => call(method, url, body, true);
  return { app, call, a, login, close: app.close };
}

const PLAYERS = ['Asha,5', 'Ben,4', 'Chen,3', 'Dev,3', 'Esha,2', 'Farid,2', 'Gita,1', 'Hari,1'].join('\n');

async function setup(s, extra = {}) {
  const t = (await s.a('POST', '/admin/api/badminton', { name: 'Friday Smash', keyword: 'Friday Smash', courts: 2, ...extra })).json;
  const id = t.tournament.id;
  await s.a('POST', `/admin/api/badminton/${id}/draw`, { players: PLAYERS, teams: 4, names: 'Smashers, Rockets, Titans, Falcons' });
  return id;
}
/** A finished match: team A wins 21-10, 21-12 (or B, with side 'b'). */
const win = (s, mid, side = 'a') => s.a('POST', `/admin/api/badminton/matches/${mid}/score`, { games: side === 'a' ? [{ a: 21, b: 10 }, { a: 21, b: 12 }] : [{ a: 10, b: 21 }, { a: 12, b: 21 }] });

test('a tournament: keyword rules, team draw, fixtures with courts and times', async () => {
  const s = await start();
  try {
    assert.equal((await s.a('POST', '/admin/api/badminton', { name: 'X', keyword: 'ab' })).status, 400);
    const made = await s.a('POST', '/admin/api/badminton', { name: 'Friday Smash', keyword: '  Friday   Smash ', courts: 2 });
    assert.equal(made.status, 201);
    assert.equal(made.json.tournament.keyword, 'friday smash', 'stored the way it is matched');
    assert.equal((await s.a('POST', '/admin/api/badminton', { name: 'Again', keyword: 'FRIDAY SMASH' })).status, 409, 'keywords are unique');
    const id = made.json.tournament.id;

    assert.equal((await s.a('POST', `/admin/api/badminton/${id}/draw`, { players: 'A\nB\nC', teams: 2 })).status, 400, 'two players a team at least');
    const drawn = await s.a('POST', `/admin/api/badminton/${id}/draw`, { players: PLAYERS, teams: 4, names: 'Smashers, Rockets, Titans, Falcons' });
    assert.equal(drawn.status, 200);
    assert.deepEqual(drawn.json.teams.map(t => t.name), ['Smashers', 'Rockets', 'Titans', 'Falcons']);
    assert.deepEqual(drawn.json.teams.map(t => t.players.length), [2, 2, 2, 2]);

    const start = '2026-12-05T09:00:00.000Z';
    const fx = await s.a('POST', `/admin/api/badminton/${id}/fixtures`, { rubbers: 'Singles, Doubles', startAt: start });
    assert.equal(fx.status, 200);
    const ms = fx.json.matches;
    assert.equal(ms.length, 12, '6 ties x 2 matches');
    assert.ok(ms.every(m => m.court >= 1 && m.court <= 2 && m.scheduledAt));
    assert.equal(ms[0].scheduledAt, start, 'the first match starts at the start time');
    // two matches at the same time never share a court or a team
    const by = {};
    for (const m of ms) (by[m.scheduledAt] = by[m.scheduledAt] || []).push(m);
    for (const list of Object.values(by)) {
      assert.equal(new Set(list.map(m => m.court)).size, list.length);
      const teams = list.flatMap(m => [m.teamA, m.teamB]);
      assert.equal(new Set(teams).size, teams.length);
    }
    assert.equal((await s.a('POST', `/admin/api/badminton/${id}/fixtures`, { rubbers: 'Singles' })).status, 409, 'fixtures are not replaced by accident');
    assert.equal((await s.a('POST', `/admin/api/badminton/${id}/fixtures`, { rubbers: 'Singles', replace: true })).json.matches.length, 6);
  } finally { await s.close(); }
});

test('scoring: points, games, a finished match, undo and the standings', async () => {
  const s = await start();
  try {
    const id = await setup(s);
    const fx = (await s.a('POST', `/admin/api/badminton/${id}/fixtures`, { rubbers: 'Singles' })).json;
    const m1 = fx.matches[0];
    const point = (side, delta = 1) => s.a('POST', `/admin/api/badminton/matches/${m1.id}/point`, { side, delta });
    const cur = async () => (await s.a('GET', `/admin/api/badminton/${id}`)).json.matches.find(m => m.id === m1.id);

    assert.equal((await point('a')).status, 200);
    let m = await cur();
    assert.equal(m.status, 'live');
    assert.deepEqual(m.current, { a: 1, b: 0, game: 1 });
    assert.equal(m.serving, 'a');
    await point('a', -1);
    assert.deepEqual((await cur()).current, { a: 0, b: 0, game: 1 }, 'undo takes the point away');

    for (let i = 0; i < 21; i++) await point('a');
    m = await cur();
    assert.equal(m.gamesWonA, 1, 'game 1 won at 21');
    assert.deepEqual(m.current, { a: 0, b: 0, game: 2 }, 'game 2 opened');
    await point('b', -1);   // nothing to take away in game 2: nothing happens
    for (let i = 0; i < 21; i++) await point('a');
    m = await cur();
    assert.equal(m.status, 'finished');
    assert.equal(m.winner, 'a');
    assert.equal((await point('a')).status, 409, 'a finished match takes no more points');
    await point('a', -1);   // reopen
    m = await cur();
    assert.equal(m.status, 'live');
    assert.equal(m.winner, '');
    assert.equal(m.current.a, 20);
    await point('a');
    assert.equal((await cur()).status, 'finished');

    // 29-29 then 30-29: the cap
    const m2 = fx.matches.find(x => x.id !== m1.id && x.court);
    const set = games => s.a('POST', `/admin/api/badminton/matches/${m2.id}/score`, { games });
    assert.equal((await set([{ a: 21, b: 20 }, { a: 5, b: 5 }])).status, 400, 'game 1 is not finished');
    assert.equal((await set([{ a: 21, b: 15 }, { a: 29, b: 29 }])).status, 200);
    let after = (await s.a('GET', `/admin/api/badminton/${id}`)).json.matches.find(x => x.id === m2.id);
    assert.equal(after.status, 'live');
    await set([{ a: 21, b: 15 }, { a: 30, b: 29 }]);
    after = (await s.a('GET', `/admin/api/badminton/${id}`)).json.matches.find(x => x.id === m2.id);
    assert.equal(after.status, 'finished');
    assert.equal(after.winner, 'a');

    // standings: a won tie gives the winner 2 points
    const table = (await s.a('GET', `/admin/api/badminton/${id}`)).json.standings;
    const first = table[0];
    assert.equal(first.points, 2);
    assert.equal(first.won, 1);
    assert.equal(first.matchesWon, 1);
    assert.equal(first.gamesWon, 2);
    assert.equal(first.pointsFor, 42);
    assert.equal(table.filter(r => r.lost === 1).length, 2, 'two ties are done: two winners and two losers');
  } finally { await s.close(); }
});

test('walkovers, resets, court clashes and the next match', async () => {
  const s = await start();
  try {
    const id = await setup(s);
    const fx = (await s.a('POST', `/admin/api/badminton/${id}/fixtures`, { rubbers: 'Singles' })).json;
    const [m1, m2] = fx.matches;
    assert.equal(m1.court, 1);
    assert.equal(m2.court, 2);
    assert.equal(fx.nextUp[0].id, m1.id, 'the next match is the first in order');

    await s.a('POST', `/admin/api/badminton/matches/${m1.id}/start`);
    // another match on the same court while it is live
    const clash = await s.a('PATCH', `/admin/api/badminton/matches/${m2.id}`, { court: 1 });
    assert.equal(clash.status, 200, 'changing a scheduled match is fine');
    assert.equal((await s.a('POST', `/admin/api/badminton/matches/${m2.id}/start`)).status, 409, 'court 1 is in use');
    await s.a('PATCH', `/admin/api/badminton/matches/${m2.id}`, { court: 2 });
    assert.equal((await s.a('POST', `/admin/api/badminton/matches/${m2.id}/start`)).status, 200);
    assert.equal((await s.a('PATCH', `/admin/api/badminton/matches/${m2.id}`, { court: 9 })).status, 400, 'only the courts there are');

    const w = await s.a('POST', `/admin/api/badminton/matches/${m1.id}/finish`, { winner: 'b', walkover: true, note: 'Team A did not turn up' });
    const got = w.json.matches.find(m => m.id === m1.id);
    assert.equal(got.status, 'walkover');
    assert.equal(got.winner, 'b');
    assert.equal(w.json.standings.find(r => r.teamId === m1.teamB).points, 2);

    const r = await s.a('POST', `/admin/api/badminton/matches/${m2.id}/reset`);
    assert.equal(r.json.matches.find(m => m.id === m2.id).status, 'scheduled');
    assert.deepEqual(r.json.matches.find(m => m.id === m2.id).games, []);
    assert.equal((await s.a('POST', `/admin/api/badminton/matches/${m1.id}/start`)).status, 200, 'a finished match can be started again only by resetting it');
  } finally { await s.close(); }
});

test('league, knockout and a champion', async () => {
  const s = await start();
  try {
    const id = await setup(s);
    const fx = (await s.a('POST', `/admin/api/badminton/${id}/fixtures`, { rubbers: 'Singles' })).json;
    assert.equal((await s.a('POST', `/admin/api/badminton/${id}/knockout`, { top: 4 })).status, 409, 'the league is not finished');
    for (const m of fx.matches) await win(s, m.id);   // team A wins every match
    let d = (await s.a('GET', `/admin/api/badminton/${id}`)).json;
    assert.ok(d.standings.every(r => r.played === 3), 'everyone played three ties');
    assert.equal(d.champion, '', 'no champion yet');

    const semi = await s.a('POST', `/admin/api/badminton/${id}/knockout`, { top: 4, rubbers: 'Singles' });
    assert.equal(semi.status, 200);
    const sm = semi.json.matches.filter(m => m.stage === 'knockout');
    assert.equal(sm.length, 2);
    assert.ok(sm.every(m => m.round === 'Semi Final'));
    const top = d.standings.map(r => r.teamId);
    assert.deepEqual([sm[0].teamA, sm[0].teamB].sort(), [top[0], top[3]].sort(), '1st plays 4th');
    assert.deepEqual([sm[1].teamA, sm[1].teamB].sort(), [top[1], top[2]].sort(), '2nd plays 3rd');
    assert.equal((await s.a('POST', `/admin/api/badminton/${id}/knockout`, { rubbers: 'Singles' })).status, 409, 'finish the semi-finals first');
    for (const m of sm) await win(s, m.id);
    const fin = await s.a('POST', `/admin/api/badminton/${id}/knockout`, { rubbers: 'Singles' });
    const f = fin.json.matches.filter(m => m.round === 'Final');
    assert.equal(f.length, 1);
    await win(s, f[0].id);
    d = (await s.a('GET', `/admin/api/badminton/${id}`)).json;
    assert.equal(d.champion, d.teams.find(t => t.id === f[0].teamA).name);
    assert.equal((await s.a('POST', `/admin/api/badminton/${id}/knockout`, { rubbers: 'Singles' })).status, 409, 'there is a champion');
    assert.ok(d.standings.every(r => r.played === 3), 'knockout matches are not in the league table');
  } finally { await s.close(); }
});

test('the live page: only the right keyword shows the scores, wrong ones are limited', async () => {
  const s = await start();
  try {
    const id = await setup(s);
    const fx = (await s.a('POST', `/admin/api/badminton/${id}/fixtures`, { rubbers: 'Singles' })).json;
    await s.a('POST', `/admin/api/badminton/matches/${fx.matches[0].id}/point`, { side: 'a' });
    await s.a('PATCH', `/admin/api/badminton/${id}`, { announcement: 'Lunch at 1' });

    const noKey = await s.call('GET', '/api/badminton/live');
    assert.equal(noKey.status, 404);
    assert.equal((await s.call('GET', '/api/badminton/live?k=wrong')).status, 404);
    const ok = await s.call('GET', '/api/badminton/live?k=%20FRIDAY%20%20smash');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.tournament.name, 'Friday Smash');
    assert.equal(ok.json.tournament.announcement, 'Lunch at 1');
    assert.equal(ok.json.live.length, 1);
    assert.deepEqual(ok.json.live[0].current, { a: 1, b: 0, game: 1 });
    assert.equal(ok.json.courts.length, 2);
    assert.equal(ok.json.courts[0].now.id, fx.matches[0].id);
    assert.ok(ok.json.courts[1].next, 'the next match on the other court');
    assert.ok(ok.json.upNext.length > 0);
    assert.equal(ok.json.standings.length, 4);
    assert.ok(!JSON.stringify(ok.json).includes('keyword'), 'the keyword is not sent back');

    await s.a('PATCH', `/admin/api/badminton/${id}`, { shared: false });
    assert.equal((await s.call('GET', '/api/badminton/live?k=friday smash')).status, 404, 'switched off');
    await s.a('PATCH', `/admin/api/badminton/${id}`, { shared: true, keyword: 'saturday finals' });
    assert.equal((await s.call('GET', '/api/badminton/live?k=friday smash')).status, 404, 'the old keyword stops working');
    assert.equal((await s.call('GET', '/api/badminton/live?k=saturday finals')).status, 200);

    // guessing keywords is limited
    let last;
    for (let i = 0; i < 35; i++) last = await s.call('GET', '/api/badminton/live?k=guess' + i);
    assert.equal(last.status, 429);
    assert.equal((await s.call('GET', '/api/badminton/live?k=saturday finals')).status, 429, 'even the right one waits');
  } finally { await s.close(); }
});

test('who may do what, and deleting a tournament', async () => {
  const s = await start();
  try {
    const id = await setup(s);
    const fx = (await s.a('POST', `/admin/api/badminton/${id}/fixtures`, { rubbers: 'Singles' })).json;
    await s.login('helper@example.com');   // a helper (support role) at the court
    assert.equal((await s.a('GET', `/admin/api/badminton/${id}`)).status, 200, 'can read');
    assert.equal((await s.a('POST', `/admin/api/badminton/matches/${fx.matches[0].id}/point`, { side: 'a' })).status, 200, 'can score');
    assert.equal((await s.a('POST', '/admin/api/badminton', { name: 'Mine', keyword: 'mine only' })).status, 403, 'cannot create');
    assert.equal((await s.a('DELETE', `/admin/api/badminton/${id}`)).status, 403, 'cannot delete');
    assert.equal((await s.call('GET', '/admin/api/badminton')).status, 401, 'signed in only');

    await s.login('boss@example.com');
    assert.equal((await s.a('DELETE', `/admin/api/badminton/${id}`)).status, 200);
    assert.equal((await s.a('GET', `/admin/api/badminton/${id}`)).status, 404);
    assert.equal(s.app.db.prepare('SELECT COUNT(*) AS n FROM bd_matches').get().n, 0, 'matches go with it');
    assert.equal(s.app.db.prepare('SELECT COUNT(*) AS n FROM bd_games').get().n, 0, 'games go with it');
    assert.equal(s.app.db.prepare('SELECT COUNT(*) AS n FROM bd_players').get().n, 0, 'players go with it');
  } finally { await s.close(); }
});
