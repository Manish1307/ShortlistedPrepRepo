// ShortlistPrep desktop look: one icon set and the progress bar used by ShortlistPrep.AI and Mock Interview.
//   Brand.icon('mic')                   -> an <svg> element (24 px grid, stroke follows the text colour)
//   <i data-icon="mic"></i>             -> replaced by that icon when the page loads (Brand.hydrate)
//   Brand.progress(host, { title, expectedSec, stages, onCancel, compact, startedAt })
//        -> { set(percent), done(text), fail(text), stop() }
//      A bar with a percentage that eases towards 94% while the work runs, and messages that change with the waiting time:
//      "Please wait…", then after 10 s "Taking longer than usual time", "Our server is working hard to find the exact results."…
// Everything shown is inserted as TEXT, never as HTML.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  const ICONS = {
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    speaker: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4"/><path d="M6.6 6.6A16.7 16.7 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4-.9"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z"/>',
    camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    chat: '<path d="M4 5h16v11H9l-5 4V5z"/>',
    move: '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/>',
    collapse: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
    dots: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    dashboard: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/>',
    external: '<path d="M7 17L17 7M9 7h8v8"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    reset: '<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
    'thumb-up': '<path d="M7 11v9H4v-9h3zM7 11l4-7c1.6 0 2.6 1.1 2.3 2.6L12.8 9H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 19H7"/>',
    'thumb-down': '<g transform="rotate(180 12 12)"><path d="M7 11v9H4v-9h3zM7 11l4-7c1.6 0 2.6 1.1 2.3 2.6L12.8 9H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 19H7"/></g>',
    play: '<path d="M7 4l13 8-13 8V4z"/>',
    send: '<path d="M4 12l16-8-6 16-3-6-7-2z"/>',
    doc: '<path d="M6 3h8l4 4v14H6V3z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
    'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
    'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18"/>',
    building: '<path d="M4 21V5l8-2v18M12 9h8v12M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2"/>',
    chart: '<path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    alert: '<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18h.01"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  };

  function icon(name, cls) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
    svg.innerHTML = ICONS[name] || ICONS.spark;   // static markup from the table above, never user text
    return svg;
  }

  /** Replace every <i data-icon="name"> under root with its icon (keeps the element's classes). */
  function hydrate(root) {
    (root || document).querySelectorAll('[data-icon]').forEach(node => {
      const svg = icon(node.dataset.icon, node.className);
      node.replaceWith(svg);
    });
  }

  /** A button's content: an icon then a text label (the label is set as text). */
  function setButton(btn, name, label) {
    btn.textContent = '';
    if (name) btn.appendChild(icon(name));
    btn.appendChild(document.createTextNode(label));
  }

  // ---- progress ------------------------------------------------------------------------------------
  // What to say at which waiting time (seconds). The headline is the first line; the second line explains.
  const WAIT = [
    [0, 'Please wait…', ''],
    [10, 'Taking longer than usual time…', 'Our server is working hard to find the exact results.'],
    [25, 'Still working on it…', 'Thank you for your patience. Detailed results take a little longer.'],
    [45, 'Almost there…', 'It is busy right now, but your request is still running.'],
    [90, 'This is taking much longer than expected.', 'You can keep waiting, or cancel and try again.'],
  ];

  function progress(host, opts) {
    opts = opts || {};
    const expected = Math.max(3, Number(opts.expectedSec) || 20);
    const t0 = opts.startedAt || Date.now();
    const stages = Array.isArray(opts.stages) ? opts.stages : [];
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

    const box = el('div', 'pg' + (opts.compact ? ' compact' : ''));
    box.setAttribute('role', 'progressbar');
    box.setAttribute('aria-valuemin', '0'); box.setAttribute('aria-valuemax', '100'); box.setAttribute('aria-valuenow', '0');
    box.setAttribute('aria-label', opts.title || 'Working');
    const head = el('div', 'pg-head');
    const title = el('div', 'pg-title');
    title.append(icon('spark', 'sm'), document.createTextNode(opts.title || 'Working on it'));
    const pct = el('span', 'pg-pct', '0%');
    head.append(title, pct);
    const track = el('div', 'pg-track'); const fill = el('div', 'pg-fill'); track.appendChild(fill);
    const msg = el('div', 'pg-msg'); msg.setAttribute('aria-live', 'polite');
    box.append(head, track);
    let stageEls = [];
    if (stages.length) {
      const row = el('div', 'pg-stages');
      stageEls = stages.map(s => row.appendChild(el('span', '', s)));
      box.appendChild(row);
    }
    box.appendChild(msg);
    let cancelRow = null;
    host.appendChild(box);

    const created = Date.now();
    let value = 0, manual = false, finished = false, lastMsg = -1, timer = null;
    const paint = v => {
      value = Math.max(value, Math.min(100, v));          // never goes backwards
      const shown = Math.round(value);
      fill.style.width = value + '%';
      pct.textContent = shown + '%';
      box.setAttribute('aria-valuenow', String(shown));
      if (stageEls.length) {
        const active = Math.min(stageEls.length - 1, Math.floor(value / 100 * stageEls.length));
        stageEls.forEach((s, i) => { s.className = finished || i < active ? 'done' : i === active ? 'on' : ''; });
      }
    };
    const say = (head1, head2, index) => {
      if (index === lastMsg) return;
      lastMsg = index;
      msg.textContent = '';
      const line = el('span', 'fade');
      line.append(el('b', '', head1));
      if (head2) line.append(document.createTextNode(' ' + head2));
      msg.appendChild(line);
    };
    const tick = () => {
      if (finished) return;
      if (!box.isConnected && Date.now() - created > 1500) { finished = true; clearInterval(timer); return; }   // its card was redrawn: stop counting
      const sec = (Date.now() - t0) / 1000;
      if (!manual) paint(94 * (1 - Math.exp(-sec / (expected * 0.55))));
      let step = 0;
      for (let i = 0; i < WAIT.length; i++) if (sec >= WAIT[i][0]) step = i;
      const w = WAIT[step];
      // while it is quick, the line under "Please wait" names the current stage
      const sub = step === 0 && stages.length ? stages[Math.min(stages.length - 1, Math.floor(value / 100 * stages.length))] + '…' : w[2];
      say(w[1], sub, step === 0 ? 'a' + (stages.length ? Math.floor(value / 100 * stages.length) : 0) : step);
      box.classList.toggle('slow', step >= 1);
      if (step === WAIT.length - 1 && opts.onCancel && !cancelRow) {
        cancelRow = el('div', 'pg-actions');
        const b = el('button', 'btn sm', 'Cancel');
        b.type = 'button';
        b.addEventListener('click', () => { api.stop(); box.remove(); opts.onCancel(); });
        cancelRow.appendChild(b);
        box.appendChild(cancelRow);
      }
    };
    tick();
    timer = setInterval(tick, 250);

    const api = {
      el: box,
      /** Real progress, when known (0 to 100). Switches off the automatic easing. */
      set(p) { manual = true; paint(Number(p) || 0); tick(); },
      /** The work finished: fill the bar, say so, and remove it after a moment (or keep it with opts.keep). */
      done(text) {
        finished = true; clearInterval(timer);
        paint(100); box.classList.add('done'); box.classList.remove('slow');
        msg.textContent = ''; msg.appendChild(el('b', '', text || 'Done'));
        if (cancelRow) cancelRow.remove();
        if (!opts.keep) setTimeout(() => { box.style.transition = 'opacity .3s'; box.style.opacity = '0'; setTimeout(() => box.remove(), 320); }, 650);
      },
      /** The work failed: turn the bar red with a message (stays until removed). */
      fail(text) {
        finished = true; clearInterval(timer);
        box.classList.add('fail'); box.classList.remove('slow');
        msg.textContent = ''; msg.appendChild(el('b', '', text || 'Something went wrong.'));
        if (cancelRow) cancelRow.remove();
      },
      /** Remove it without a message. */
      stop() { finished = true; clearInterval(timer); box.remove(); },
    };
    return api;
  }

  window.Brand = { icon, hydrate, setButton, progress, ICONS };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => hydrate());
  else hydrate();
})();
