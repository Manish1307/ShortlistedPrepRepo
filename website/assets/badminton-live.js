// Live badminton scores (private page). Asks the server for the scoreboard of the keyword in ?k= (or typed, or remembered in
// this browser) every few seconds. Everything shown is inserted as text, never as HTML.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var KEY = 'sp_bd_keyword';
  var REFRESH_MS = 5000;
  var $ = function (id) { return document.getElementById(id); };
  var keyword = '', timer = null, lastOk = 0, inFlight = false;

  function store() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function h(tag, cls, children) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    [].concat(children === undefined ? [] : children).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    });
    return e;
  }
  function fill(node, kids) { node.replaceChildren.apply(node, kids); }
  function timeOf(iso) {
    var d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  }
  function who(name, players, serving) {
    return h('span', 'bl-team', [serving ? h('i', 'bl-serve') : null, name, players ? h('small', 'bl-players', players) : null]);
  }
  function gameLine(m) {
    return m.games.length ? h('div', 'bl-games', m.games.map(function (g) { return h('span', '', 'G' + g.no + ' ' + g.a + '-' + g.b); })) : null;
  }

  function courtCard(c) {
    var m = c.now;
    if (!m) {
      var n = c.next;
      return h('div', 'bl-court', [
        h('div', 'bl-court-head', [h('span', '', 'Court ' + c.court), h('span', '', 'Free')]),
        n ? h('div', 'bl-muted', ['Next: ' + n.teamA + ' vs ' + n.teamB + (n.kind ? ' (' + n.kind + ')' : '') + (timeOf(n.scheduledAt) ? ' · ' + timeOf(n.scheduledAt) : '')]) : h('div', 'bl-empty', 'No match waiting')]);
    }
    var cur = m.current || { a: 0, b: 0 };
    return h('div', 'bl-court live', [
      h('div', 'bl-court-head', [h('span', '', 'Court ' + c.court + ' · ' + [m.round, m.kind].filter(Boolean).join(' · ')), h('span', '', 'Game ' + (m.current ? m.current.game : 1))]),
      h('div', 'bl-side', [who(m.teamA, m.playersA, m.serving === 'a'), h('span', 'bl-score', cur.a)]),
      h('div', 'bl-side', [who(m.teamB, m.playersB, m.serving === 'b'), h('span', 'bl-score', cur.b)]),
      $('bl-board').dataset.gtw === '1' ? null : h('div', 'bl-muted bl-small', 'Games won: ' + m.gamesWonA + ' - ' + m.gamesWonB + ' (first to ' + $('bl-board').dataset.gtw + ')'),
      $('bl-board').dataset.gtw === '1' ? null : gameLine(m),
      c.next ? h('div', 'bl-muted bl-small', 'Next on this court: ' + c.next.teamA + ' vs ' + c.next.teamB) : null]);
  }

  function upItem(m) {
    return h('div', 'bl-item', [
      h('div', 'bl-meta', [h('span', '', [m.court ? 'Court ' + m.court : 'Court to be told', m.round ? ' · ' + m.round : '', m.kind ? ' · ' + m.kind : ''].join('')), h('span', '', timeOf(m.scheduledAt))]),
      h('div', 'bl-vs', m.teamA + ' vs ' + m.teamB),
      m.playersA || m.playersB ? h('div', 'bl-muted bl-small', [m.playersA, m.playersB].filter(Boolean).join(' vs ')) : null]);
  }
  function resultItem(m) {
    var winner = m.winner === 'a' ? m.teamA : m.winner === 'b' ? m.teamB : '';
    return h('div', 'bl-item', [
      h('div', 'bl-meta', [h('span', '', [m.court ? 'Court ' + m.court : '', m.round ? ' · ' + m.round : '', m.kind ? ' · ' + m.kind : ''].join('').replace(/^ · /, '')), h('span', '', m.status === 'walkover' ? 'Walkover' : '')]),
      h('div', 'bl-vs', m.teamA + ' vs ' + m.teamB),
      h('div', 'bl-res', [h('b', 'bl-won', winner ? winner + ' won ' : ''), m.games.length ? m.games.map(function (g) { return g.a + '-' + g.b; }).join(', ') : (m.note || '')])]);
  }

  function render(d) {
    var t = d.tournament;
    $('bl-title').textContent = t.name;
    $('bl-sub').textContent = 'Live scores · first to ' + t.rules.pointsToWin + ' points, ' + (t.rules.gamesToWin === 1 ? 'one game a match' : 'best of ' + (t.rules.gamesToWin * 2 - 1) + ' games');
    $('bl-board').dataset.gtw = t.rules.gamesToWin;
    var chip = $('bl-status');
    var live = d.live.length > 0;
    chip.textContent = t.status === 'finished' ? 'Finished' : live ? 'Live' : t.status === 'live' ? 'In progress' : 'Not started';
    chip.className = 'bl-chip' + (live ? ' live' : t.status === 'finished' ? ' done' : '');
    $('bl-venue').textContent = t.venue ? t.venue : '';
    var a = $('bl-announce'); a.hidden = !t.announcement; a.textContent = t.announcement || '';
    var c = $('bl-champion'); c.hidden = !d.champion; c.textContent = d.champion ? 'Champions: ' + d.champion : '';
    fill($('bl-courts'), d.courts.map(courtCard));
    fill($('bl-next'), d.upNext.length ? d.upNext.map(upItem) : [h('p', 'bl-empty', 'No matches waiting.')]);
    fill($('bl-results'), d.results.length ? d.results.map(resultItem) : [h('p', 'bl-empty', 'No results yet.')]);
    var cols = ['#', 'Team', 'P', 'W', 'D', 'L', 'Pts', 'MW', 'GD', 'PD'];
    fill($('bl-table'), [
      h('thead', '', [h('tr', '', cols.map(function (x) { return h('th', '', x); }))]),
      h('tbody', '', d.standings.map(function (r) {
        return h('tr', '', [h('td', '', r.rank), h('td', '', r.name), h('td', '', r.played), h('td', '', r.won), h('td', '', r.drawn), h('td', '', r.lost),
          h('td', 'pts', r.points), h('td', '', r.matchesWon), h('td', '', r.gamesWon - r.gamesLost), h('td', '', r.pointsFor - r.pointsAgainst)]);
      }))]);
    fill($('bl-teams'), d.teams.map(function (x) { return h('div', 'bl-item', [h('b', '', x.name), h('span', '', x.players.join(', '))]); }));
    lastOk = Date.now();
    tick();
  }

  function tick() {
    var s = Math.max(0, Math.round((Date.now() - lastOk) / 1000));
    $('bl-updated').textContent = lastOk ? (s < 3 ? 'Updated just now' : 'Updated ' + s + 's ago') : '';
  }

  function showForm(message) {
    clearTimeout(timer);
    $('bl-board').hidden = true;
    $('bl-form').hidden = false;
    var e = $('bl-error'); e.hidden = !message; e.textContent = message || '';
    $('bl-title').textContent = 'Live badminton scores';
    $('bl-sub').textContent = 'Enter the match keyword you got from the organiser.';
    $('bl-key').focus();
  }

  function load(first) {
    if (inFlight) return;
    inFlight = true;
    fetch(API + '/api/badminton/live?k=' + encodeURIComponent(keyword), { cache: 'no-store' }).then(function (r) {
      return r.json().then(function (d) { return { status: r.status, data: d }; });
    }).then(function (res) {
      if (res.status === 200) {
        storeKeep(keyword);   // remembered in this browser only after it worked
        $('bl-form').hidden = true; $('bl-board').hidden = false;
        render(res.data);
        schedule();
      } else if (res.status === 404 || res.status === 429) {
        storeKeep('');
        showForm(res.data && res.data.error ? res.data.error : 'No scoreboard for that keyword.');
      } else if (first) { showForm('Something went wrong. Please try again.'); } else { $('bl-updated').textContent = 'Connection problem, trying again…'; schedule(); }
    }).catch(function () {
      if (first) showForm('Could not reach the scoreboard. Check your internet and try again.');
      else { $('bl-updated').textContent = 'Connection problem, trying again…'; schedule(); }
    }).then(function () { inFlight = false; });
  }
  function storeKeep(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (e) { /* private mode */ } }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () { if (!document.hidden) load(false); else schedule(); }, REFRESH_MS);
  }

  $('bl-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var k = $('bl-key').value.trim();
    if (!k) { showForm('Type the keyword first.'); return; }
    keyword = k;
    history.replaceState(null, '', location.pathname + '?k=' + encodeURIComponent(k));
    load(true);
  });
  $('bl-change').addEventListener('click', function () { storeKeep(''); keyword = ''; history.replaceState(null, '', location.pathname); $('bl-key').value = ''; showForm(''); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && keyword) load(false); });
  setInterval(tick, 1000);

  var q = new URLSearchParams(location.search).get('k');
  var saved = store();
  keyword = (q || saved || '').trim();
  if (keyword) { $('bl-key').value = keyword; load(true); } else { showForm(''); }
})();
