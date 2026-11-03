'use strict';
// Badminton tournaments (private: not linked anywhere on the public website). The admin makes a tournament, decides the
// teams (by hand or a fair random draw), generates the fixtures (every team plays every other team; each tie is a few
// matches such as singles and doubles), gives each match a court and a time, scores it point by point, and reads the
// standings and the next matches. The team shares a link with the tournament's keyword: the live page asks the server for
// that keyword's scoreboard (GET /api/badminton/live) and shows the latest score, court by court.
//
// Rules (set per tournament): a game goes to `pointsToWin` (21), must be won by `winBy` (2), and the first to the hard cap
// (30) wins; a match is the best of `gamesToWin` games (2 = best of 3). A tie is won by the team that wins more of its
// matches; the winner of a tie gets `tiePoints` (2), a level tie gives each team half.

const crypto = require('crypto');
const { ApiError, text, integer } = require('./http');
const { now, transaction } = require('./db');
const auth = require('./auth');

const STATUSES = ['draft', 'live', 'finished'];
const DEFAULT_RUBBERS = ['Singles', 'Doubles'];
const KEYWORD = /^[a-z0-9][a-z0-9 _-]{3,39}$/;

/** A keyword as people type it: trimmed, lower case, one space between words. */
const normKeyword = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------------------------------------------------
// Pure rules (no database): unit-tested on their own.

/** Who has won a game: 'a', 'b' or '' while it is still being played. */
function gameWinner(a, b, { pointsToWin = 21, winBy = 2, pointCap = 30 } = {}) {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (hi >= pointCap) return a > b ? 'a' : 'b';
  if (hi >= pointsToWin && hi - lo >= winBy) return a > b ? 'a' : 'b';
  return '';
}

/** Games won by each side and the match winner ('' until a side has `gamesToWin` games). */
function matchState(games, rules) {
  let a = 0, b = 0;
  for (const g of games) { const w = gameWinner(g.a, g.b, rules); if (w === 'a') a++; else if (w === 'b') b++; }
  return { a, b, winner: a >= rules.gamesToWin ? 'a' : b >= rules.gamesToWin ? 'b' : '' };
}

/** Fisher-Yates with a crypto random number (rand(n) → 0..n-1 can be replaced in tests). */
function shuffle(list, rand = n => crypto.randomInt(n)) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * A fair random draw: players are sorted by level (strongest first, random among equals) and dealt out "snake" style
 * (1 2 3 3 2 1 1 2 3 …), so every team gets a mix of strong and weaker players. → array of teams, each an array of players.
 */
function drawTeams(players, teamCount, rand) {
  const order = shuffle(players, rand).sort((x, y) => (y.level || 3) - (x.level || 3));
  const teams = Array.from({ length: teamCount }, () => []);
  order.forEach((p, i) => {
    const round = Math.floor(i / teamCount), pos = i % teamCount;
    teams[round % 2 === 0 ? pos : teamCount - 1 - pos].push(p);
  });
  return teams;
}

/** Round robin pairings by the circle method: [[ [a,b], [c,d] ], …] one array of pairs per round; a team never plays twice in a round. */
function roundRobin(ids, legs = 1) {
  const list = ids.slice();
  if (list.length % 2) list.push(null);   // a bye
  const n = list.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const x = list[i], y = list[n - 1 - i];
      if (x !== null && y !== null) pairs.push(r % 2 ? [y, x] : [x, y]);
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop());   // keep the first team, rotate the others
  }
  const out = rounds.slice();
  if (legs === 2) rounds.forEach(pairs => out.push(pairs.map(([x, y]) => [y, x])));
  return out;
}

/**
 * Courts and time slots for matches in order: each goes to the earliest slot with a free court where neither team is
 * already playing. busy: courts and teams taken in slot 0 (matches being played now). Sets item.slot and item.court (1-based).
 */
function assignSlots(items, courts, busy = {}) {
  const slots = [];
  const slotAt = i => slots[i] || (slots[i] = { teams: new Set(i === 0 ? busy.teams || [] : []), taken: new Set(i === 0 ? busy.courts || [] : []) });
  for (const it of items) {
    const teams = [it.teamA, it.teamB].filter(Boolean);
    for (let s = 0; s < 10000; s++) {
      const slot = slotAt(s);
      if (teams.some(t => slot.teams.has(t))) continue;
      let court = 0;
      for (let c = 1; c <= courts; c++) if (!slot.taken.has(c)) { court = c; break; }
      if (!court) continue;
      slot.taken.add(court);
      teams.forEach(t => slot.teams.add(t));
      it.slot = s; it.court = court;
      break;
    }
  }
  return items;
}

/** Result of a tie from its matches: { complete, winsA, winsB, winner: teamId | null (level) }. Cancelled matches do not count. */
function tieResult(matches) {
  const live = matches.filter(m => m.status !== 'cancelled');
  const done = live.filter(m => m.status === 'finished' || m.status === 'walkover');
  const a = matches[0].teamA, b = matches[0].teamB;
  const winsA = done.filter(m => m.winner === 'a').length, winsB = done.filter(m => m.winner === 'b').length;
  const complete = live.length > 0 && done.length === live.length;
  return { complete, winsA, winsB, teamA: a, teamB: b, winner: complete && winsA !== winsB ? (winsA > winsB ? a : b) : null };
}

/** Matches grouped into ties (matches with the same tie number; a match with none is a tie of its own). */
function tiesOf(matches) {
  const by = new Map();
  for (const m of matches) {
    if (!m.teamA || !m.teamB) continue;
    const key = m.tieNo ? 't' + m.tieNo : 'm' + m.id;
    (by.get(key) || by.set(key, []).get(key)).push(m);
  }
  return [...by.values()];
}

/** The league table: ties played/won/drawn/lost, tie points, matches, games and points for and against. */
function standings(teams, matches, tiePoints = 2) {
  const row = t => ({ teamId: t.id, name: t.name, played: 0, won: 0, drawn: 0, lost: 0, points: 0, matchesWon: 0, matchesLost: 0, gamesWon: 0, gamesLost: 0, pointsFor: 0, pointsAgainst: 0 });
  const rows = new Map(teams.map(t => [t.id, row(t)]));
  for (const m of matches) {
    if (m.stage === 'knockout' || (m.status !== 'finished' && m.status !== 'walkover')) continue;   // the table is the league's
    const A = rows.get(m.teamA), B = rows.get(m.teamB);
    if (!A || !B) continue;
    for (const [me, op, side] of [[A, B, 'a'], [B, A, 'b']]) {
      if (m.winner === side) me.matchesWon++; else if (m.winner) me.matchesLost++;
      for (const g of m.games) {
        const mine = side === 'a' ? g.a : g.b, theirs = side === 'a' ? g.b : g.a;
        me.pointsFor += mine; me.pointsAgainst += theirs;
        if (gameWon(g, side, m.rules)) me.gamesWon++; else if (gameWon(g, side === 'a' ? 'b' : 'a', m.rules)) me.gamesLost++;
      }
    }
  }
  for (const tie of tiesOf(matches.filter(m => m.stage !== 'knockout'))) {
    const r = tieResult(tie);
    if (!r.complete) continue;
    const A = rows.get(r.teamA), B = rows.get(r.teamB);
    if (!A || !B) continue;
    A.played++; B.played++;
    if (r.winner === null) { A.drawn++; B.drawn++; A.points += tiePoints / 2; B.points += tiePoints / 2; }
    else { const w = r.winner === r.teamA ? A : B, l = w === A ? B : A; w.won++; l.lost++; w.points += tiePoints; }
  }
  return [...rows.values()].sort((x, y) =>
    y.points - x.points || (y.matchesWon - y.matchesLost) - (x.matchesWon - x.matchesLost) || (y.gamesWon - y.gamesLost) - (x.gamesWon - x.gamesLost)
    || (y.pointsFor - y.pointsAgainst) - (x.pointsFor - x.pointsAgainst) || x.name.localeCompare(y.name))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
const gameWon = (g, side, rules) => gameWinner(g.a, g.b, rules) === side;

const roundName = teamsLeft => (teamsLeft === 2 ? 'Final' : teamsLeft === 4 ? 'Semi Final' : teamsLeft === 8 ? 'Quarter Final' : `Round of ${teamsLeft}`);

// ---------------------------------------------------------------------------------------------------------------------
// Routes

function addRoutes(ctx) {
  const { db, add, audit, one, all } = ctx;
  const limiter = ctx.limiters && ctx.limiters.badminton || new auth.Limiter({ max: 30, windowMs: 10 * 60 * 1000 });
  const touch = id => db.prepare('UPDATE bd_tournaments SET updated_at = ? WHERE id = ?').run(now(), id);
  const insert = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);

  const tournamentRow = id => { const t = one('SELECT * FROM bd_tournaments WHERE id = ?', id); if (!t) throw new ApiError(404, 'Tournament not found'); return t; };
  const rulesOf = t => ({ gamesToWin: t.games_to_win, pointsToWin: t.points_to_win, winBy: t.win_by, pointCap: t.point_cap });
  const matchRow = id => {
    const m = one('SELECT * FROM bd_matches WHERE id = ?', id);
    if (!m) throw new ApiError(404, 'Match not found');
    return m;
  };

  /** Everything about one tournament, as the admin screen and the live page need it. */
  function load(t) {
    const rules = rulesOf(t);
    const teams = all('SELECT * FROM bd_teams WHERE tournament_id = ? ORDER BY id', t.id).map(x => ({
      id: x.id, name: x.name, color: x.color, players: all('SELECT id, name, level FROM bd_players WHERE team_id = ? ORDER BY id', x.id) }));
    const name = new Map(teams.map(x => [x.id, x.name]));
    const gamesBy = new Map();
    for (const g of all('SELECT g.* FROM bd_games g JOIN bd_matches m ON m.id = g.match_id WHERE m.tournament_id = ? ORDER BY g.match_id, g.game_no', t.id)) {
      (gamesBy.get(g.match_id) || gamesBy.set(g.match_id, []).get(g.match_id)).push({ no: g.game_no, a: g.a, b: g.b });
    }
    const matches = all('SELECT * FROM bd_matches WHERE tournament_id = ? ORDER BY match_no, id', t.id).map(m => {
      const games = gamesBy.get(m.id) || [];
      const state = matchState(games, rules);
      const last = games[games.length - 1];
      return { id: m.id, tieNo: m.tie_no, matchNo: m.match_no, stage: m.stage, round: m.round_label, kind: m.kind, teamA: m.team_a, teamB: m.team_b,
        teamAName: name.get(m.team_a) || 'To be decided', teamBName: name.get(m.team_b) || 'To be decided', playersA: m.players_a, playersB: m.players_b,
        court: m.court, scheduledAt: m.scheduled_at, status: m.status, winner: m.winner, serving: m.serving, note: m.note, startedAt: m.started_at, finishedAt: m.finished_at,
        games, gamesWonA: state.a, gamesWonB: state.b, current: m.status === 'live' && last ? { a: last.a, b: last.b, game: last.no } : null, rules };
    });
    const table = standings(teams, matches, t.tie_points);
    return { teams, matches, table, rules };
  }

  const champion = (t, data) => {
    const ko = data.matches.filter(m => m.stage === 'knockout');
    if (ko.length) {
      const last = tiesOf(ko).filter(x => x[0].round === ko[ko.length - 1].round);
      if (last.length === 1) { const r = tieResult(last[0]); if (r.winner) return data.teams.find(x => x.id === r.winner).name; }
      return '';
    }
    return t.status === 'finished' && data.table.length && data.table[0].played ? data.table[0].name : '';
  };

  const detail = t => {
    const data = load(t);
    const upcoming = data.matches.filter(m => m.status === 'scheduled' && m.teamA && m.teamB);
    const site = String(process.env.SITE_URL || 'https://shortlistprep.com').replace(/\/+$/, '');
    return {
      shareUrl: `${site}/badminton-live.html?k=${encodeURIComponent(t.keyword)}`,
      tournament: present(t), teams: data.teams, matches: data.matches, standings: data.table, nextUp: upcoming.slice(0, 6), champion: champion(t, data),
    };
  };
  const present = t => ({ id: t.id, name: t.name, keyword: t.keyword, venue: t.venue, courts: t.courts, gamesToWin: t.games_to_win, pointsToWin: t.points_to_win,
    winBy: t.win_by, pointCap: t.point_cap, tiePoints: t.tie_points, minutesPerMatch: t.minutes_per_match, startsAt: t.starts_at, announcement: t.announcement,
    status: t.status, shared: !!t.shared, createdAt: t.created_at, updatedAt: t.updated_at });

  /** Settings from a request body (on top of the current ones when editing). */
  function settingsFrom(body, cur = {}) {
    const pick = (key, fallback) => (body[key] === undefined ? fallback : body[key]);
    const s = {
      name: text(pick('name', cur.name), 80, { required: true, field: 'Tournament name' }),
      keyword: normKeyword(pick('keyword', cur.keyword)),
      venue: text(pick('venue', cur.venue || ''), 100, { field: 'Venue' }),
      courts: integer(pick('courts', cur.courts || 2), { min: 1, max: 12, field: 'Courts' }),
      games_to_win: integer(pick('gamesToWin', cur.games_to_win || 2), { min: 1, max: 3, field: 'Games to win a match' }),
      points_to_win: integer(pick('pointsToWin', cur.points_to_win || 21), { min: 5, max: 30, field: 'Points in a game' }),
      win_by: integer(pick('winBy', cur.win_by || 2), { min: 1, max: 2, field: 'Win by' }),
      point_cap: integer(pick('pointCap', cur.point_cap || 30), { min: 5, max: 50, field: 'Point cap' }),
      tie_points: integer(pick('tiePoints', cur.tie_points || 2), { min: 1, max: 6, field: 'Points for a tie win' }),
      minutes_per_match: integer(pick('minutesPerMatch', cur.minutes_per_match || 30), { min: 5, max: 180, field: 'Minutes per match' }),
      starts_at: text(pick('startsAt', cur.starts_at || ''), 40, { field: 'Start time' }),
      announcement: text(pick('announcement', cur.announcement || ''), 200, { field: 'Announcement' }),
      status: pick('status', cur.status || 'draft'),
      shared: pick('shared', cur.shared === undefined ? 1 : cur.shared) ? 1 : 0,
    };
    if (!KEYWORD.test(s.keyword)) throw new ApiError(400, 'The keyword needs 4 to 40 letters, numbers, spaces, dashes or underscores (for example "friday-smash").');
    if (s.point_cap < s.points_to_win) throw new ApiError(400, 'The point cap cannot be lower than the points in a game');
    if (s.starts_at && Number.isNaN(Date.parse(s.starts_at))) throw new ApiError(400, 'The start time is not a date and time');
    if (!STATUSES.includes(s.status)) throw new ApiError(400, 'Unknown status');
    return s;
  }
  const keywordTaken = (keyword, exceptId = 0) => !!one('SELECT id FROM bd_tournaments WHERE keyword = ? AND id <> ?', keyword, exceptId);

  // ===================== admin: tournaments =====================

  add('GET', '/admin/api/badminton', { admin: true }, () => ({
    tournaments: all('SELECT * FROM bd_tournaments ORDER BY id DESC').map(t => ({ ...present(t),
      teams: one('SELECT COUNT(*) AS n FROM bd_teams WHERE tournament_id = ?', t.id).n,
      matches: one('SELECT COUNT(*) AS n FROM bd_matches WHERE tournament_id = ?', t.id).n,
      played: one("SELECT COUNT(*) AS n FROM bd_matches WHERE tournament_id = ? AND status IN ('finished','walkover')", t.id).n })),
  }));

  add('POST', '/admin/api/badminton', { admin: true, perm: 'badminton.write' }, (req, res, { body, admin }) => {
    const s = settingsFrom(body);
    if (keywordTaken(s.keyword)) throw new ApiError(409, 'Another tournament already uses that keyword. Choose a different one.');
    const t = now();
    const id = insert(`INSERT INTO bd_tournaments (name, keyword, venue, courts, games_to_win, points_to_win, win_by, point_cap, tie_points, minutes_per_match, starts_at, announcement, status, shared, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, s.name, s.keyword, s.venue, s.courts, s.games_to_win, s.points_to_win, s.win_by, s.point_cap, s.tie_points, s.minutes_per_match, s.starts_at, s.announcement, s.status, s.shared, t, t);
    audit(admin, 'badminton.created', s.name, s.keyword);
    return { status: 201, body: detail(tournamentRow(id)) };
  });

  add('GET', '/admin/api/badminton/:id', { admin: true }, (req, res, { params }) => detail(tournamentRow(params.id)));

  add('PATCH', '/admin/api/badminton/:id', { admin: true, perm: 'badminton.write' }, (req, res, { params, body, admin }) => {
    const cur = tournamentRow(params.id);
    const s = settingsFrom(body, cur);
    if (keywordTaken(s.keyword, cur.id)) throw new ApiError(409, 'Another tournament already uses that keyword. Choose a different one.');
    db.prepare(`UPDATE bd_tournaments SET name=?, keyword=?, venue=?, courts=?, games_to_win=?, points_to_win=?, win_by=?, point_cap=?, tie_points=?, minutes_per_match=?, starts_at=?, announcement=?, status=?, shared=?, updated_at=? WHERE id=?`)
      .run(s.name, s.keyword, s.venue, s.courts, s.games_to_win, s.points_to_win, s.win_by, s.point_cap, s.tie_points, s.minutes_per_match, s.starts_at, s.announcement, s.status, s.shared, now(), cur.id);
    audit(admin, 'badminton.updated', s.name, s.keyword);
    return detail(tournamentRow(cur.id));
  });

  add('DELETE', '/admin/api/badminton/:id', { admin: true, perm: 'badminton.write' }, (req, res, { params, admin }) => {
    const t = tournamentRow(params.id);
    db.prepare('DELETE FROM bd_tournaments WHERE id = ?').run(t.id);   // teams, players, matches and games go with it
    audit(admin, 'badminton.deleted', t.name, t.keyword);
    return { ok: true };
  });

  // ===================== admin: teams and players =====================

  const teamRow = id => { const x = one('SELECT * FROM bd_teams WHERE id = ?', id); if (!x) throw new ApiError(404, 'Team not found'); return x; };
  const playersFrom = list => (Array.isArray(list) ? list : []).slice(0, 30).map(p => (typeof p === 'string' ? { name: p, level: 3 } : p || {}))
    .map(p => ({ name: text(p.name, 60, { field: 'Player name' }), level: integer(p.level === undefined || p.level === '' ? 3 : p.level, { min: 1, max: 5, field: 'Player level' }) })).filter(p => p.name);

  add('POST', '/admin/api/badminton/:id/teams', { admin: true, perm: 'badminton.write' }, (req, res, { params, body }) => {
    const t = tournamentRow(params.id);
    const name = text(body.name, 60, { required: true, field: 'Team name' });
    if (one('SELECT id FROM bd_teams WHERE tournament_id = ? AND lower(name) = lower(?)', t.id, name)) throw new ApiError(409, 'There is already a team with that name');
    const id = transaction(db, () => {
      const teamId = insert('INSERT INTO bd_teams (tournament_id, name, color) VALUES (?,?,?)', t.id, name, text(body.color, 20, { field: 'Colour' }));
      for (const p of playersFrom(body.players)) insert('INSERT INTO bd_players (team_id, tournament_id, name, level) VALUES (?,?,?,?)', teamId, t.id, p.name, p.level);
      return teamId;
    });
    touch(t.id);
    return { status: 201, body: { ok: true, teamId: id, ...detail(tournamentRow(t.id)) } };
  });

  add('PATCH', '/admin/api/badminton/teams/:tid', { admin: true, perm: 'badminton.write' }, (req, res, { params, body }) => {
    const team = teamRow(params.tid);
    const name = text(body.name === undefined ? team.name : body.name, 60, { required: true, field: 'Team name' });
    if (one('SELECT id FROM bd_teams WHERE tournament_id = ? AND lower(name) = lower(?) AND id <> ?', team.tournament_id, name, team.id)) throw new ApiError(409, 'There is already a team with that name');
    db.prepare('UPDATE bd_teams SET name = ?, color = ? WHERE id = ?').run(name, text(body.color === undefined ? team.color : body.color, 20, { field: 'Colour' }), team.id);
    touch(team.tournament_id);
    return detail(tournamentRow(team.tournament_id));
  });

  add('DELETE', '/admin/api/badminton/teams/:tid', { admin: true, perm: 'badminton.write' }, (req, res, { params }) => {
    const team = teamRow(params.tid);
    if (one('SELECT id FROM bd_matches WHERE tournament_id = ? AND (team_a = ? OR team_b = ?)', team.tournament_id, team.id, team.id)) throw new ApiError(409, 'This team has matches. Delete its matches first (or all fixtures).');
    db.prepare('DELETE FROM bd_teams WHERE id = ?').run(team.id);
    touch(team.tournament_id);
    return detail(tournamentRow(team.tournament_id));
  });

  add('POST', '/admin/api/badminton/:id/players', { admin: true, perm: 'badminton.write' }, (req, res, { params, body }) => {
    const t = tournamentRow(params.id), team = teamRow(body.teamId);
    if (team.tournament_id !== t.id) throw new ApiError(400, 'That team is in another tournament');
    const [p] = playersFrom([{ name: body.name, level: body.level }]);
    if (!p) throw new ApiError(400, 'Player name is required');
    insert('INSERT INTO bd_players (team_id, tournament_id, name, level) VALUES (?,?,?,?)', team.id, t.id, p.name, p.level);
    touch(t.id);
    return detail(tournamentRow(t.id));
  });

  add('PATCH', '/admin/api/badminton/players/:pid', { admin: true, perm: 'badminton.write' }, (req, res, { params, body }) => {
    const p = one('SELECT * FROM bd_players WHERE id = ?', params.pid);
    if (!p) throw new ApiError(404, 'Player not found');
    const [n] = playersFrom([{ name: body.name === undefined ? p.name : body.name, level: body.level === undefined ? p.level : body.level }]);
    if (!n) throw new ApiError(400, 'Player name is required');
    let teamId = p.team_id;
    if (body.teamId !== undefined) { const team = teamRow(body.teamId); if (team.tournament_id !== p.tournament_id) throw new ApiError(400, 'That team is in another tournament'); teamId = team.id; }
    db.prepare('UPDATE bd_players SET name = ?, level = ?, team_id = ? WHERE id = ?').run(n.name, n.level, teamId, p.id);
    touch(p.tournament_id);
    return detail(tournamentRow(p.tournament_id));
  });

  add('DELETE', '/admin/api/badminton/players/:pid', { admin: true, perm: 'badminton.write' }, (req, res, { params }) => {
    const p = one('SELECT * FROM bd_players WHERE id = ?', params.pid);
    if (!p) throw new ApiError(404, 'Player not found');
    db.prepare('DELETE FROM bd_players WHERE id = ?').run(p.id);
    touch(p.tournament_id);
    return detail(tournamentRow(p.tournament_id));
  });

  // The team draw: a list of players (with a level 1 to 5) is dealt into balanced teams. replace: false keeps the teams that exist.
  add('POST', '/admin/api/badminton/:id/draw', { admin: true, perm: 'badminton.write' }, (req, res, { params, body, admin }) => {
    const t = tournamentRow(params.id);
    const players = playersFrom(typeof body.players === 'string' ? body.players.split(/\n/).map(l => { const m = /^(.*?)(?:\s*[,:;-]\s*([1-5]))?$/.exec(l.trim()); return m && m[1] ? { name: m[1], level: m[2] || 3 } : null; }).filter(Boolean) : body.players);
    const count = integer(body.teams, { min: 2, max: 32, field: 'Number of teams' });
    if (players.length < count * 2) throw new ApiError(400, `Add at least ${count * 2} players for ${count} teams (two a team).`);
    const names = (Array.isArray(body.names) ? body.names : String(body.names || '').split(/[\n,]+/)).map(s => String(s).trim()).filter(Boolean);
    if (body.replace && one("SELECT id FROM bd_matches WHERE tournament_id = ? AND status <> 'scheduled'", t.id)) throw new ApiError(409, 'Matches have already been played. Start a new tournament to draw teams again.');
    const dealt = drawTeams(players, count, ctx.random);
    transaction(db, () => {
      if (body.replace) { db.prepare('DELETE FROM bd_matches WHERE tournament_id = ?').run(t.id); db.prepare('DELETE FROM bd_teams WHERE tournament_id = ?').run(t.id); }
      const taken = new Set(all('SELECT lower(name) AS n FROM bd_teams WHERE tournament_id = ?', t.id).map(r => r.n));
      dealt.forEach((members, i) => {
        let name = names[i] || `Team ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`;
        while (taken.has(name.toLowerCase())) name += ' 2';
        taken.add(name.toLowerCase());
        const id = insert('INSERT INTO bd_teams (tournament_id, name, color) VALUES (?,?,?)', t.id, name, '');
        for (const p of members) insert('INSERT INTO bd_players (team_id, tournament_id, name, level) VALUES (?,?,?,?)', id, t.id, p.name, p.level);
      });
    });
    touch(t.id);
    audit(admin, 'badminton.draw', t.name, `${players.length} players, ${count} teams`);
    return detail(tournamentRow(t.id));
  });

  // ===================== admin: fixtures =====================

  const rubbersFrom = v => {
    const list = (Array.isArray(v) ? v : String(v || '').split(/[\n,]+/)).map(s => String(s).trim()).filter(Boolean).slice(0, 9);
    if (list.some(s => s.length > 30)) throw new ApiError(400, 'A match name is too long');
    return list.length ? list : DEFAULT_RUBBERS;
  };
  const startMs = (t, body) => {
    const raw = body.startAt || t.starts_at;
    const ms = raw ? Date.parse(raw) : NaN;
    return Number.isNaN(ms) ? 0 : ms;
  };
  const when = (ms, slot, minutes) => (ms ? new Date(ms + slot * minutes * 60000).toISOString() : '');
  const nextTie = tid => (one('SELECT COALESCE(MAX(tie_no), 0) + 1 AS n FROM bd_matches WHERE tournament_id = ?', tid).n);
  const nextNo = tid => (one('SELECT COALESCE(MAX(match_no), 0) + 1 AS n FROM bd_matches WHERE tournament_id = ?', tid).n);

  /** Everyone plays everyone: ties made from the pairings, matches (rubbers) made for each tie, then courts and times. */
  add('POST', '/admin/api/badminton/:id/fixtures', { admin: true, perm: 'badminton.write' }, (req, res, { params, body, admin }) => {
    const t = tournamentRow(params.id);
    const teams = all('SELECT id FROM bd_teams WHERE tournament_id = ? ORDER BY id', t.id).map(x => x.id);
    if (teams.length < 2) throw new ApiError(400, 'Add at least two teams first.');
    const legs = integer(body.legs === undefined ? 1 : body.legs, { min: 1, max: 2, field: 'Rounds' });
    const rubbers = rubbersFrom(body.rubbers);
    if (one("SELECT id FROM bd_matches WHERE tournament_id = ? AND stage = 'league'", t.id)) {
      if (!body.replace) throw new ApiError(409, 'Fixtures already exist. Choose "replace" to make them again.');
      if (one("SELECT id FROM bd_matches WHERE tournament_id = ? AND status <> 'scheduled'", t.id)) throw new ApiError(409, 'Matches have already started, so the fixtures cannot be replaced.');
    }
    const start = startMs(t, body);
    transaction(db, () => {
      db.prepare('DELETE FROM bd_matches WHERE tournament_id = ?').run(t.id);
      let tieNo = 0;
      const items = [];
      roundRobin(teams, legs).forEach((pairs, r) => pairs.forEach(([a, b]) => {
        tieNo++;
        rubbers.forEach(kind => items.push({ tieNo, round: `Round ${r + 1}`, kind, teamA: a, teamB: b }));
      }));
      assignSlots(items, t.courts);
      for (const it of items) {
        insert(`INSERT INTO bd_matches (tournament_id, tie_no, match_no, stage, round_label, kind, team_a, team_b, court, scheduled_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          t.id, it.tieNo, it.slot * t.courts + it.court, 'league', it.round, it.kind, it.teamA, it.teamB, it.court, when(start, it.slot, t.minutes_per_match));
      }
    });
    touch(t.id);
    audit(admin, 'badminton.fixtures', t.name, `${teams.length} teams`);
    return detail(tournamentRow(t.id));
  });

  /** Courts and times again for the matches not yet played (after adding a court, a delay, or a manual match). */
  add('POST', '/admin/api/badminton/:id/reschedule', { admin: true, perm: 'badminton.write' }, (req, res, { params, body, admin }) => {
    const t = tournamentRow(params.id);
    const start = Date.parse(body.startAt || '') || Date.now();
    const live = all("SELECT court, team_a, team_b FROM bd_matches WHERE tournament_id = ? AND status = 'live'", t.id);
    const todo = all("SELECT * FROM bd_matches WHERE tournament_id = ? AND status = 'scheduled' ORDER BY match_no, id", t.id)
      .map(m => ({ id: m.id, teamA: m.team_a, teamB: m.team_b }));
    assignSlots(todo, t.courts, { courts: live.map(m => m.court).filter(Boolean), teams: live.flatMap(m => [m.team_a, m.team_b]) });
    transaction(db, () => {
      const base = one("SELECT COALESCE(MAX(match_no), 0) AS n FROM bd_matches WHERE tournament_id = ? AND status <> 'scheduled'", t.id).n;
      const up = db.prepare('UPDATE bd_matches SET match_no = ?, court = ?, scheduled_at = ? WHERE id = ?');
      for (const it of todo) up.run(base + it.slot * t.courts + it.court, it.court, when(start, it.slot, t.minutes_per_match), it.id);
    });
    touch(t.id);
    audit(admin, 'badminton.rescheduled', t.name);
    return detail(tournamentRow(t.id));
  });

  /**
   * Knockout rounds. First call: the top N teams of the table (N = 2, 4, 8 …) are paired best against worst. Later calls: the
   * winners of the last knockout round are paired in order. A level tie cannot go through: add a deciding match first.
   */
  add('POST', '/admin/api/badminton/:id/knockout', { admin: true, perm: 'badminton.write' }, (req, res, { params, body, admin }) => {
    const t = tournamentRow(params.id);
    const data = load(t);
    const rubbers = rubbersFrom(body.rubbers);
    const ko = data.matches.filter(m => m.stage === 'knockout');
    let seeds;
    if (!ko.length) {
      const top = integer(body.top === undefined ? 4 : body.top, { min: 2, max: 32, field: 'Teams in the knockout' });
      if (![2, 4, 8, 16, 32].includes(top)) throw new ApiError(400, 'Choose 2, 4, 8, 16 or 32 teams');
      if (data.table.length < top) throw new ApiError(400, `There are only ${data.table.length} teams`);
      if (data.matches.some(m => m.stage === 'league' && !['finished', 'walkover', 'cancelled'].includes(m.status))) throw new ApiError(409, 'Finish the league matches first, so the table is final.');
      const best = data.table.slice(0, top).map(r => r.teamId);
      seeds = best.slice(0, top / 2).map((id, i) => [id, best[top - 1 - i]]);
    } else {
      const lastRound = ko[ko.length - 1].round;
      const ties = tiesOf(ko).filter(x => x[0].round === lastRound);
      const winners = [];
      for (const tie of ties) {
        const r = tieResult(tie);
        if (!r.complete) throw new ApiError(409, `Finish every ${lastRound} match first.`);
        if (!r.winner) throw new ApiError(409, `A ${lastRound} tie is level (${r.winsA}-${r.winsB}). Add a deciding match, then try again.`);
        winners.push(r.winner);
      }
      if (winners.length < 2) throw new ApiError(409, 'The final has been played: there is a champion.');
      seeds = []; for (let i = 0; i < winners.length; i += 2) seeds.push([winners[i], winners[i + 1]]);
    }
    const label = roundName(seeds.length * 2);
    const start = startMs(t, body) || Date.parse(one("SELECT MAX(scheduled_at) AS m FROM bd_matches WHERE tournament_id = ?", t.id).m || '') + t.minutes_per_match * 60000 || 0;
    transaction(db, () => {
      const items = [];
      let tieNo = nextTie(t.id);
      for (const [a, b] of seeds) { rubbers.forEach(kind => items.push({ tieNo, round: label, kind, teamA: a, teamB: b })); tieNo++; }
      assignSlots(items, t.courts);
      const base = nextNo(t.id) - 1;
      for (const it of items) {
        insert(`INSERT INTO bd_matches (tournament_id, tie_no, match_no, stage, round_label, kind, team_a, team_b, court, scheduled_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          t.id, it.tieNo, base + 1 + it.slot * t.courts + it.court, 'knockout', it.round, it.kind, it.teamA, it.teamB, it.court, when(start, it.slot, t.minutes_per_match));
      }
    });
    touch(t.id);
    audit(admin, 'badminton.knockout', t.name, label);
    return detail(tournamentRow(t.id));
  });

  // ===================== admin: one match =====================

  const matchFields = (t, body, cur = {}) => {
    const team = (key, curVal) => {
      if (body[key] === undefined) return curVal;
      if (body[key] === null || body[key] === '') return null;
      const x = teamRow(body[key]);
      if (x.tournament_id !== t.id) throw new ApiError(400, 'That team is in another tournament');
      return x.id;
    };
    const out = {
      team_a: team('teamA', cur.team_a === undefined ? null : cur.team_a), team_b: team('teamB', cur.team_b === undefined ? null : cur.team_b),
      kind: text(body.kind === undefined ? cur.kind || 'Singles' : body.kind, 30, { field: 'Match type' }) || 'Singles',
      round_label: text(body.round === undefined ? cur.round_label || '' : body.round, 40, { field: 'Round' }),
      players_a: text(body.playersA === undefined ? cur.players_a || '' : body.playersA, 100, { field: 'Players of team A' }),
      players_b: text(body.playersB === undefined ? cur.players_b || '' : body.playersB, 100, { field: 'Players of team B' }),
      court: body.court === undefined ? (cur.court === undefined ? null : cur.court) : (body.court === null || body.court === '' ? null : integer(body.court, { min: 1, max: t.courts, field: `Court (1 to ${t.courts})` })),
      scheduled_at: text(body.scheduledAt === undefined ? cur.scheduled_at || '' : body.scheduledAt, 40, { field: 'Time' }),
      note: text(body.note === undefined ? cur.note || '' : body.note, 200, { field: 'Note' }),
    };
    if (out.team_a && out.team_a === out.team_b) throw new ApiError(400, 'A team cannot play itself');
    if (out.scheduled_at && Number.isNaN(Date.parse(out.scheduled_at))) throw new ApiError(400, 'The time is not a date and time');
    return out;
  };
  /** Another live match on the same court at the same time is a clash the admin should hear about, not a silent overwrite. */
  const courtBusy = (m, court) => court && one("SELECT id FROM bd_matches WHERE tournament_id = ? AND court = ? AND status = 'live' AND id <> ?", m.tournament_id, court, m.id);

  add('POST', '/admin/api/badminton/:id/matches', { admin: true, perm: 'badminton.write' }, (req, res, { params, body }) => {
    const t = tournamentRow(params.id);
    const f = matchFields(t, body);
    const tie = body.tieNo ? integer(body.tieNo, { min: 1, max: 100000, field: 'Tie number' }) : nextTie(t.id);
    insert(`INSERT INTO bd_matches (tournament_id, tie_no, match_no, stage, round_label, kind, team_a, team_b, players_a, players_b, court, scheduled_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t.id, tie, nextNo(t.id), body.stage === 'knockout' ? 'knockout' : 'league', f.round_label, f.kind, f.team_a, f.team_b, f.players_a, f.players_b, f.court, f.scheduled_at, f.note);
    touch(t.id);
    return { status: 201, body: detail(tournamentRow(t.id)) };
  });

  add('PATCH', '/admin/api/badminton/matches/:mid', { admin: true, perm: 'badminton.write' }, (req, res, { params, body }) => {
    const m = matchRow(params.mid), t = tournamentRow(m.tournament_id);
    if (m.status !== 'scheduled' && (body.teamA !== undefined || body.teamB !== undefined)) throw new ApiError(409, 'The teams cannot change once the match has started. Reset the match first.');
    const f = matchFields(t, body, m);
    if (courtBusy(m, f.court) && m.status === 'live') throw new ApiError(409, `Court ${f.court} has another match being played`);
    const matchNo = body.matchNo === undefined ? m.match_no : integer(body.matchNo, { min: 1, max: 100000, field: 'Order' });
    const status = body.status === undefined ? m.status : body.status;
    if (!['scheduled', 'cancelled'].includes(status) && status !== m.status) throw new ApiError(400, 'Use Start, Finish or Reset to change a match that is being played');
    db.prepare('UPDATE bd_matches SET team_a=?, team_b=?, kind=?, round_label=?, players_a=?, players_b=?, court=?, scheduled_at=?, note=?, match_no=?, status=? WHERE id=?')
      .run(f.team_a, f.team_b, f.kind, f.round_label, f.players_a, f.players_b, f.court, f.scheduled_at, f.note, matchNo, status, m.id);
    touch(m.tournament_id);
    return detail(tournamentRow(m.tournament_id));
  });

  add('DELETE', '/admin/api/badminton/matches/:mid', { admin: true, perm: 'badminton.write' }, (req, res, { params }) => {
    const m = matchRow(params.mid);
    db.prepare('DELETE FROM bd_matches WHERE id = ?').run(m.id);
    touch(m.tournament_id);
    return detail(tournamentRow(m.tournament_id));
  });

  /**
   * Makes a match's state follow its games: the match is finished when a side has won enough games, a new empty game is
   * opened when the last one is decided, and a match that was finished goes back to live when a point is taken away.
   */
  function settle(m, t) {
    const rules = rulesOf(t);
    let games = all('SELECT game_no, a, b FROM bd_games WHERE match_id = ? ORDER BY game_no', m.id).map(g => ({ no: g.game_no, a: g.a, b: g.b }));
    const state = matchState(games, rules);
    const last = games[games.length - 1];
    if (state.winner) {
      db.prepare("UPDATE bd_matches SET status = 'finished', winner = ?, finished_at = COALESCE(NULLIF(finished_at, ''), ?) WHERE id = ?").run(state.winner, now(), m.id);
      return;
    }
    if (last && gameWinner(last.a, last.b, rules)) db.prepare('INSERT INTO bd_games (match_id, game_no, a, b) VALUES (?,?,0,0)').run(m.id, last.no + 1);
    db.prepare("UPDATE bd_matches SET status = 'live', winner = '', finished_at = '' WHERE id = ?").run(m.id);
  }

  function startIfNeeded(m, t) {
    if (m.status === 'cancelled') throw new ApiError(409, 'This match was cancelled');
    if (!m.team_a || !m.team_b) throw new ApiError(409, 'Both teams must be chosen before the match can start');
    if (m.status === 'scheduled') {
      if (courtBusy(m, m.court)) throw new ApiError(409, `Court ${m.court} has another match being played. Finish it first or pick another court.`);
      db.prepare("UPDATE bd_matches SET status = 'live', started_at = ? WHERE id = ?").run(now(), m.id);
    }
    if (!one('SELECT 1 AS x FROM bd_games WHERE match_id = ?', m.id)) db.prepare('INSERT INTO bd_games (match_id, game_no, a, b) VALUES (?,1,0,0)').run(m.id);
  }

  add('POST', '/admin/api/badminton/matches/:mid/start', { admin: true, perm: 'badminton.score' }, (req, res, { params }) => {
    const m = matchRow(params.mid), t = tournamentRow(m.tournament_id);
    startIfNeeded(m, t);
    if (t.status === 'draft') db.prepare("UPDATE bd_tournaments SET status = 'live' WHERE id = ?").run(t.id);
    touch(t.id);
    return detail(tournamentRow(t.id));
  });

  /** One point for a side ({ side: 'a' | 'b', delta: 1 | -1 }). Takes a point away across game boundaries and out of a finished match. */
  add('POST', '/admin/api/badminton/matches/:mid/point', { admin: true, perm: 'badminton.score' }, (req, res, { params, body }) => {
    const m = matchRow(params.mid), t = tournamentRow(m.tournament_id);
    const side = body.side === 'b' ? 'b' : body.side === 'a' ? 'a' : null;
    const delta = Number(body.delta) === -1 ? -1 : 1;
    if (!side) throw new ApiError(400, 'Choose side a or b');
    if (delta === 1 && (m.status === 'finished' || m.status === 'walkover')) throw new ApiError(409, 'This match is finished. Take a point away to reopen it, or reset the match.');
    transaction(db, () => {
      startIfNeeded(m, t);
      let games = all('SELECT game_no, a, b FROM bd_games WHERE match_id = ? ORDER BY game_no', m.id);
      let last = games[games.length - 1];
      if (delta === -1) {
        if (last.a + last.b === 0 && games.length > 1) { db.prepare('DELETE FROM bd_games WHERE match_id = ? AND game_no = ?').run(m.id, last.game_no); games.pop(); last = games[games.length - 1]; }
        if (last[side] > 0) db.prepare(`UPDATE bd_games SET ${side} = ${side} - 1 WHERE match_id = ? AND game_no = ?`).run(m.id, last.game_no);
      } else {
        db.prepare(`UPDATE bd_games SET ${side} = ${side} + 1 WHERE match_id = ? AND game_no = ?`).run(m.id, last.game_no);
        db.prepare('UPDATE bd_matches SET serving = ? WHERE id = ?').run(side, m.id);
      }
      settle(matchRow(m.id), t);
    });
    if (t.status === 'draft') db.prepare("UPDATE bd_tournaments SET status = 'live' WHERE id = ?").run(t.id);
    touch(t.id);
    return detail(tournamentRow(t.id));
  });

  /** Sets the whole score: { games: [{ a, b }, …] } (the last game may still be going). For a score kept on paper. */
  add('POST', '/admin/api/badminton/matches/:mid/score', { admin: true, perm: 'badminton.score' }, (req, res, { params, body }) => {
    const m = matchRow(params.mid), t = tournamentRow(m.tournament_id);
    if (!Array.isArray(body.games) || body.games.length < 1 || body.games.length > 5) throw new ApiError(400, 'Send between 1 and 5 games');
    const rules = rulesOf(t);
    const games = body.games.map((g, i) => ({ a: integer(g && g.a, { min: 0, max: rules.pointCap, field: `Game ${i + 1}, team A` }), b: integer(g && g.b, { min: 0, max: rules.pointCap, field: `Game ${i + 1}, team B` }) }));
    games.forEach((g, i) => {
      if (i < games.length - 1 && !gameWinner(g.a, g.b, rules)) throw new ApiError(400, `Game ${i + 1} is not finished (${g.a}-${g.b}). Only the last game can be unfinished.`);
    });
    transaction(db, () => {
      startIfNeeded(m, t);
      db.prepare('DELETE FROM bd_games WHERE match_id = ?').run(m.id);
      games.forEach((g, i) => db.prepare('INSERT INTO bd_games (match_id, game_no, a, b) VALUES (?,?,?,?)').run(m.id, i + 1, g.a, g.b));
      settle(matchRow(m.id), t);
    });
    touch(t.id);
    return detail(tournamentRow(t.id));
  });

  /** Ends a match by hand: a walkover, a retirement, or a result with no score. { winner: 'a' | 'b', walkover: true, note } */
  add('POST', '/admin/api/badminton/matches/:mid/finish', { admin: true, perm: 'badminton.score' }, (req, res, { params, body }) => {
    const m = matchRow(params.mid), t = tournamentRow(m.tournament_id);
    if (body.winner !== 'a' && body.winner !== 'b') throw new ApiError(400, 'Choose the winner');
    if (!m.team_a || !m.team_b) throw new ApiError(409, 'Both teams must be chosen first');
    db.prepare('UPDATE bd_matches SET status = ?, winner = ?, finished_at = ?, note = ? WHERE id = ?')
      .run(body.walkover ? 'walkover' : 'finished', body.winner, now(), text(body.note === undefined ? m.note : body.note, 200, { field: 'Note' }), m.id);
    touch(t.id);
    return detail(tournamentRow(t.id));
  });

  add('POST', '/admin/api/badminton/matches/:mid/reset', { admin: true, perm: 'badminton.score' }, (req, res, { params }) => {
    const m = matchRow(params.mid);
    transaction(db, () => {
      db.prepare('DELETE FROM bd_games WHERE match_id = ?').run(m.id);
      db.prepare("UPDATE bd_matches SET status = 'scheduled', winner = '', serving = '', started_at = '', finished_at = '' WHERE id = ?").run(m.id);
    });
    touch(m.tournament_id);
    return detail(tournamentRow(m.tournament_id));
  });

  // ===================== public: the live page =====================
  // No sign-in: whoever has the keyword sees the scoreboard. Wrong keywords are counted per address so one cannot be guessed.

  add('GET', '/api/badminton/live', { public: true }, (req, res, { query, ip }) => {
    if (limiter.blocked(ip)) throw new ApiError(429, 'Too many wrong keywords. Please try again in a few minutes.');
    const keyword = normKeyword(query.get('k'));
    const t = keyword && one('SELECT * FROM bd_tournaments WHERE keyword = ? AND shared = 1', keyword);
    if (!t) { limiter.hit(ip); throw new ApiError(404, 'No scoreboard for that keyword. Check it with the organiser.'); }
    const data = load(t);
    const pub = m => ({ id: m.id, matchNo: m.matchNo, round: m.round, kind: m.kind, teamA: m.teamAName, teamB: m.teamBName, playersA: m.playersA, playersB: m.playersB,
      court: m.court, scheduledAt: m.scheduledAt, status: m.status, winner: m.winner, serving: m.serving, games: m.games, gamesWonA: m.gamesWonA, gamesWonB: m.gamesWonB,
      current: m.current, note: m.note });
    const ready = data.matches.filter(m => m.teamA && m.teamB && m.status !== 'cancelled');
    const live = ready.filter(m => m.status === 'live');
    const upcoming = ready.filter(m => m.status === 'scheduled');
    const done = ready.filter(m => m.status === 'finished' || m.status === 'walkover').sort((x, y) => String(y.finishedAt).localeCompare(String(x.finishedAt)));
    const courts = Array.from({ length: t.courts }, (_, i) => i + 1).map(c => ({
      court: c, now: live.find(m => m.court === c) ? pub(live.find(m => m.court === c)) : null,
      next: upcoming.find(m => m.court === c) ? pub(upcoming.find(m => m.court === c)) : null }));
    return {
      ok: true, serverTime: now(),
      tournament: { name: t.name, venue: t.venue, status: t.status, announcement: t.announcement, updatedAt: t.updated_at, courts: t.courts,
        rules: { gamesToWin: t.games_to_win, pointsToWin: t.points_to_win, winBy: t.win_by, pointCap: t.point_cap } },
      champion: champion(t, data), live: live.map(pub), courts, upNext: upcoming.slice(0, 6).map(pub), results: done.slice(0, 12).map(pub),
      standings: data.table, teams: data.teams.map(x => ({ name: x.name, players: x.players.map(p => p.name) })),
    };
  });
}

module.exports = { addRoutes, gameWinner, matchState, drawTeams, roundRobin, assignSlots, tieResult, tiesOf, standings, normKeyword, shuffle, KEYWORD };
