// ShortlistPrep admin dashboard. Everything shown is inserted as text (never as HTML), so a customer's name or
// message can never run code in this page.
(function () {
  'use strict';

  // ---------- tiny helpers ----------
  const root = document.getElementById('app');
  let me = null;
  let openCount = 0;
  let newOppCount = 0;
  let newDemoCount = 0;
  let view = 'overview';

  /** h('div', {class: 'x', onclick: fn}, 'text', childNode, ...) builds an element. */
  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;   // the page's security policy forbids style="" attributes, but allows this
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === undefined || c === null || c === false) continue;
      e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'admin' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* no body */ }
    if (res.status === 401 && me) { me = null; render(); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  const get = url => api('GET', url);
  const post = (url, body) => api('POST', url, body || {});
  const patch = (url, body) => api('PATCH', url, body || {});
  const del = url => api('DELETE', url);

  function toast(message, isError) {
    const t = h('div', { class: 'toast' + (isError ? ' error' : '') }, message);
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), isError ? 6000 : 3000);
  }
  /** Run an action; show its error as a message instead of breaking the page. */
  async function guard(fn) { try { return await fn(); } catch (err) { toast(err.message, true); return undefined; } }

  const money = (cents, cur) => {
    try { return new Intl.NumberFormat((cur || 'INR') === 'INR' ? 'en-IN' : undefined, { style: 'currency', currency: cur || 'INR' }).format((cents || 0) / 100); }
    catch (_) { return `${((cents || 0) / 100).toFixed(2)} ${cur || ''}`; }
  };
  const date = s => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const dateTime = s => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const moneyList = list => (list && list.some(r => r.cents) ? list.filter(r => r.cents).map(r => money(r.cents, r.currency)).join(' + ') : money(0, 'INR'));
  const can = permission => ({
    'badminton.write': ['owner', 'admin'], 'badminton.score': ['owner', 'admin', 'support'],
    'customers.write': ['owner', 'admin'], 'licence.major': ['owner', 'admin'], 'orders.write': ['owner', 'admin'],
    'releases.write': ['owner', 'admin'], 'aikeys.write': ['owner', 'admin'], 'conversations.delete': ['owner', 'admin'], 'profiles.write': ['owner', 'admin', 'support'], 'accounts.write': ['owner', 'admin'], 'jobs.write': ['owner', 'admin'], 'tokens.write': ['owner', 'admin'], 'pricing.write': ['owner', 'admin'], 'opportunities.write': ['owner', 'admin', 'support'], 'demos.write': ['owner', 'admin', 'support'], 'offers.write': ['owner', 'admin'], 'team': ['owner'],
  }[permission] || []).includes(me.role);

  const STATUS_PILL = { default: 'good', approved: 'good', rejected: 'bad', pending: 'warn', on: 'good', off: 'bad', active: 'good', expired: 'warn', revoked: 'bad', paid: 'good', refunded: 'warn', failed: 'bad', open: 'warn', closed: '', new: 'warn', contacted: '', qualified: 'good', won: 'good', lost: 'bad', demo: 'good', interest: '', signup: '', contact: '', Booked: 'warn', Confirmed: 'good', Completed: 'good', Cancelled: 'bad', 'No show': 'bad' };
  const pill = text => h('span', { class: 'pill ' + (STATUS_PILL[text] || '') }, text);

  // ---------- dialogs and forms ----------
  function dialog(title, content, buttons = []) {
    const dlg = h('dialog', {});
    const close = () => { dlg.close(); dlg.remove(); };
    dlg.append(
      h('div', { class: 'dlg-head' }, h('h2', { style: 'margin:0' }, title), h('button', { class: 'x', 'aria-label': 'Close', onclick: close }, '×')),
      h('div', { class: 'dlg-body' }, content),
      buttons.length ? h('div', { class: 'dlg-foot' }, buttons.map(b => h('button', {
        class: 'btn ' + (b.kind || ''), type: 'button',
        onclick: async () => { const keep = await b.run(close); if (keep !== true && b.closes !== false) close(); },
      }, b.label))) : null,
    );
    dlg.addEventListener('cancel', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    return { close, el: dlg };
  }

  /** field('Name', {name:'name', type:'text', ...}) */
  function field(label, props, hint) {
    let input;
    if (props.type === 'select') {
      input = h('select', { name: props.name }, props.options.map(o => h('option', { value: o.value }, o.label)));
      if (props.value !== undefined) input.value = props.value;
    } else if (props.type === 'textarea') {
      input = h('textarea', { name: props.name, maxlength: props.maxlength }, props.value || '');
    } else {
      input = h('input', { name: props.name, type: props.type || 'text', required: props.required, min: props.min, max: props.max, placeholder: props.placeholder, autocomplete: 'off', maxlength: props.maxlength });
      if (props.value !== undefined) input.value = props.value;
    }
    return h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
  }
  const values = node => Object.fromEntries([...node.querySelectorAll('[name]')].map(i => [i.name, i.type === 'checkbox' ? i.checked : i.value]));

  // ---------- table ----------
  function table(columns, rows, onRow, emptyText) {
    if (!rows.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, emptyText || 'Nothing here yet.'));
    return h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, columns.map(c => h('th', {}, c.label)))),
      h('tbody', {}, rows.map(r => h('tr', onRow ? { class: 'click', tabindex: '0', onclick: () => onRow(r), onkeydown: e => { if (e.key === 'Enter') onRow(r); } } : {},
        columns.map(c => h('td', { class: c.wrap ? 'wrap' : '' }, c.render(r))))))));
  }

  function head(title, ...tools) { return h('div', { class: 'head' }, h('h1', {}, title), h('div', { class: 'tools' }, tools)); }
  function searchBox(onSearch, placeholder, initial = '') {
    let timer;
    return h('input', { type: 'search', placeholder, value: initial, 'aria-label': placeholder, oninput: e => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => onSearch(v), 250); } });
  }

  // ---------- sign in ----------
  function renderLogin() {
    const error = h('p', { class: 'error-text' });
    const form = h('form', {
      onsubmit: async e => {
        e.preventDefault();
        error.textContent = '';
        try {
          const v = values(form);
          const res = await post('/admin/api/login', { email: v.email, password: v.password });
          me = res.admin; view = 'overview'; render();
        } catch (err) { error.textContent = err.message; }
      },
    },
      field('Email', { name: 'email', type: 'email', required: true }),
      field('Password', { name: 'password', type: 'password', required: true }),
      error,
      h('button', { class: 'btn primary', type: 'submit', style: 'width:100%' }, 'Sign in'));
    root.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'login' },
      h('div', { class: 'logo' }, 'S'), h('h1', {}, 'ShortlistPrep admin'), h('p', { class: 'muted' }, 'Sign in to manage customers, licences and releases.'), form)));
    const first = form.querySelector('input'); if (first) first.focus();
  }

  // ---------- shell: top header with grouped menus, a page header, and the page ----------
  const ICONS = {
    dashboard: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c.8-3.6 3.4-5.5 7-5.5s6.2 1.9 7 5.5M16 5a3.5 3.5 0 0 1 0 7M18 14.8c2 .6 3.4 2.4 4 5.2"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
    doc: '<path d="M6 3h8l4 4v14H6V3z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    chat: '<path d="M4 5h16v11H9l-5 4V5z"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="8" cy="8" r="1.5"/>',
    box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4V7z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    logout: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
  };
  /** A small line icon (the markup is fixed above, never user text). */
  function icon(name, cls) {
    const s = document.createElement('span');
    s.className = 'ico' + (cls ? ' ' + cls : '');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
    return s;
  }

  // the menu: groups of pages, each with a one-line description (shown in the menu and in the page header)
  const GROUPS = [
    { id: 'overview', label: 'Overview', items: [['overview', 'Overview', 'Revenue, licences and website activity at a glance.', 'dashboard']] },
    { id: 'growth', label: 'Growth', items: [
      ['opportunities', 'Opportunities', 'Demo requests and enquiries that came from the website.', 'target'],
      ['atschecks', 'ATS checks', 'Resumes checked on the website, with the contact details and score of each visitor.', 'doc'],
      ['demos', '1-on-1 demos', 'Free demo sessions booked on the website: slots, meeting links and status.', 'chat'],
      ['visitors', 'Website visits', 'Who visits the website and where they come from.', 'globe']] },
    { id: 'customers', label: 'Customers', items: [
      ['customers', 'Customers', 'Customer records, licences and website logins.', 'users'],
      ['candidates', 'Candidates', 'Career toolkit progress, documents and AI activity.', 'briefcase'],
      ['licences', 'Licences', 'Issue, extend or cancel licences and see the computers using them.', 'key']] },
    { id: 'learning', label: 'Activity', items: [
      ['conversations', 'Conversations', 'ShortlistPrep.AI sessions saved by the app.', 'chat'],
      ['profiles', 'Topics and resume', 'The topics and resume that set the area of the AI answers.', 'doc']] },
    { id: 'ai', label: 'AI and jobs', items: [
      ['jobs', 'Jobs', 'AI Job search: the Master Prompt, companies and live openings.', 'briefcase'],
      ['tokens', 'AI tokens', 'The daily AI allowance, token packs and requests for more.', 'bolt'],
      ['aikeys', 'AI keys', 'AI service keys and which licence uses which.', 'lock']] },
    { id: 'sales', label: 'Sales', items: [
      ['orders', 'Orders', 'Payments, refunds and plan orders.', 'receipt'],
      ['pricing', 'Pricing', 'Plans, prices, offers and payment settings.', 'tag'],
      ['offers', 'Offer bar', 'The offer strip and coupon code shown at the top of the website.', 'bolt']] },
    { id: 'company', label: 'Company', items: [
      ['messages', 'Support', 'Support messages from customers.', 'mail'],
      ['releases', 'Releases', 'App versions and download links.', 'box'],
      ['badminton', 'Badminton', 'Private tournaments: teams, fixtures, courts and live scores.', 'trophy'],
      ['audit', 'Audit log', 'Everything the admins changed.', 'shield'],
      ['team', 'Team', 'Admin accounts and their roles.', 'users']] },
  ];
  const PAGES = {};
  GROUPS.forEach(g => g.items.forEach(([id, label, desc, ico]) => { PAGES[id] = { id, label, desc, ico, group: g.label }; }));
  PAGES.account = { id: 'account', label: 'My account', desc: 'Your sign-in details and password.', ico: 'user', group: 'You' };
  const NAV = Object.keys(PAGES).map(id => [id, PAGES[id].label]);   // kept for anything that lists the pages

  let menuOpen = null;   // the group, 'user' or 'mobile' that is open
  function closeMenus() {
    menuOpen = null;
    document.querySelectorAll('.topbar .open').forEach(n => n.classList.remove('open'));
    const bar = document.querySelector('.topbar'); if (bar) bar.classList.remove('nav-open');
    document.querySelectorAll('.topbar [aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
  function toggleMenu(key, node, btn) {
    const was = menuOpen === key;
    const bar = document.querySelector('.topbar');
    const mobileOpen = bar.classList.contains('nav-open') && key !== 'user';   // a group opens inside the open phone menu
    closeMenus();
    if (mobileOpen) bar.classList.add('nav-open');
    if (!was) { menuOpen = key; node.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
  }
  if (!window.__adminMenus) {   // once: a click elsewhere or Escape closes the menus
    window.__adminMenus = true;
    document.addEventListener('click', e => { if (menuOpen && !e.target.closest('.topbar')) closeMenus(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && menuOpen) closeMenus(); });
  }
  const go = id => { closeMenus(); view = id; render(); window.scrollTo(0, 0); };
  const badgeFor = id => (id === 'messages' ? openCount : id === 'opportunities' ? newOppCount : id === 'demos' ? newDemoCount : 0);

  function header() {
    const items = g => g.items.filter(([id]) => id !== 'team' || me.role === 'owner');
    const groups = GROUPS.map(g => ({ ...g, items: items(g) })).filter(g => g.items.length);
    const active = PAGES[view] || PAGES.overview;
    const nav = h('nav', { class: 'topnav', id: 'topnav', 'aria-label': 'Main' }, groups.map(g => {
      if (g.items.length === 1 && g.id === 'overview') {
        const [id, label] = g.items[0];
        return h('div', { class: 'ng' }, h('button', { class: 'ng-btn' + (view === id ? ' active' : ''), 'aria-current': view === id ? 'page' : null, onclick: () => go(id) }, label));
      }
      const here = g.items.some(([id]) => id === view);
      const count = g.items.reduce((n, [id]) => n + badgeFor(id), 0);
      const wrap = h('div', { class: 'ng' });
      const btn = h('button', { class: 'ng-btn' + (here ? ' active' : ''), type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: e => { e.stopPropagation(); toggleMenu(g.id, wrap, btn); } },
        g.label, count ? h('span', { class: 'badge-count' }, count) : null, icon('chevron', 'caret'));
      wrap.append(btn, h('div', { class: 'ng-menu', role: 'menu' }, g.items.map(([id, label, desc, ico]) =>
        h('button', { class: 'ng-item' + (view === id ? ' on' : ''), role: 'menuitem', onclick: () => go(id) },
          icon(ico), h('span', { class: 'ng-text' }, h('b', {}, label), h('small', {}, desc)), badgeFor(id) ? h('span', { class: 'badge-count' }, badgeFor(id)) : null))));
      return wrap;
    }));
    // you
    const initials = String(me.email || '?').split('@')[0].split(/[._-]/).map(p => p[0] || '').join('').slice(0, 2).toUpperCase() || '?';
    const youWrap = h('div', { class: 'ng you' });
    const youBtn = h('button', { class: 'you-btn', type: 'button', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': 'Your account', onclick: e => { e.stopPropagation(); toggleMenu('user', youWrap, youBtn); } },
      h('span', { class: 'avatar' }, initials), h('span', { class: 'you-text' }, h('b', {}, String(me.email).split('@')[0]), h('small', {}, me.role)), icon('chevron', 'caret'));
    youWrap.append(youBtn, h('div', { class: 'ng-menu right', role: 'menu' },
      h('div', { class: 'you-card' }, h('b', {}, me.email), h('span', { class: 'pill' }, me.role)),
      h('button', { class: 'ng-item', role: 'menuitem', onclick: () => go('account') }, icon('user'), h('span', { class: 'ng-text' }, h('b', {}, 'My account'), h('small', {}, 'Your sign-in details and password'))),
      h('button', { class: 'ng-item danger', role: 'menuitem', onclick: async () => { await guard(() => post('/admin/api/logout')); me = null; closeMenus(); render(); } }, icon('logout'), h('span', { class: 'ng-text' }, h('b', {}, 'Sign out')))));
    const burger = h('button', { class: 'menu-btn', type: 'button', 'aria-label': 'Menu', 'aria-controls': 'topnav', 'aria-expanded': 'false', onclick: e => {
      e.stopPropagation();
      const bar = document.querySelector('.topbar'), was = bar.classList.contains('nav-open');
      closeMenus();
      if (!was) { menuOpen = 'mobile'; bar.classList.add('nav-open'); burger.setAttribute('aria-expanded', 'true'); }
    } }, icon('menu'));
    const bar = h('header', { class: 'topbar' }, h('div', { class: 'topbar-in' },
      burger,
      h('a', { class: 'brand', href: '#', onclick: e => { e.preventDefault(); go('overview'); } }, h('span', { class: 'logo' }, 'S'), h('span', { class: 'brand-text' }, 'ShortlistPrep', h('small', {}, 'Admin'))),
      nav, h('div', { class: 'top-right' }, youWrap)));
    return bar;
  }

  /** The page header: where you are, the page title and what the page is for, with quick links to what needs attention. */
  function banner() {
    const p = PAGES[view] || PAGES.overview;
    const chip = (label, n, id) => h('button', { class: 'chip' + (n ? ' hot' : ''), onclick: () => go(id) }, h('b', {}, String(n)), label);
    return h('section', { class: 'banner' }, h('div', { class: 'banner-in' },
      h('div', { class: 'banner-text' },
        h('div', { class: 'crumbs' }, h('span', {}, 'Admin'), h('i', {}, '›'), h('span', {}, p.group), p.group !== p.label ? [h('i', {}, '›'), h('b', {}, p.label)] : null),
        h('h1', { id: 'page-title' }, p.label),
        h('p', {}, p.desc)),
      h('div', { class: 'banner-chips' }, chip(' open support', openCount, 'messages'), chip(' new enquiries', newOppCount, 'opportunities'),
        h('span', { class: 'today' }, new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })))));
  }

  async function render() {
    if (!me) return renderLogin();
    const content = h('main', { class: 'main', id: 'content' });
    root.replaceChildren(h('div', { class: 'shell' }, header(), banner(), content));
    document.title = (PAGES[view] || PAGES.overview).label + ' · ShortlistPrep admin';
    const seen = openCount + ':' + newOppCount;
    await guard(() => VIEWS[view](content));
    if (seen !== openCount + ':' + newOppCount && me) { const shellEl = root.firstChild; shellEl.replaceChild(header(), shellEl.children[0]); shellEl.replaceChild(banner(), shellEl.children[1]); }
    // the page header already shows the title: a page's own heading is hidden when it says the same, leaving its tools
    const title = (PAGES[view] || PAGES.overview).label;
    const first = content.querySelector('.head > h1');
    if (first && first.textContent.trim() === title) { first.classList.add('dup'); first.parentElement.classList.add('solo'); }
  }



  async function refreshOpenCount() {
    try { openCount = (await get('/admin/api/messages?status=open')).messages.length; newOppCount = (await get('/admin/api/opportunities?status=new')).counts.new; newDemoCount = (await get('/admin/api/demos?status=booked')).counts.booked; } catch (_) { /* ignore */ }
  }

  // ---------- overview ----------
  async function overview(el) {
    const o = await get('/admin/api/overview');
    openCount = o.openMessages;
    newOppCount = o.website.newOpportunities;
    const stat = (label, num, sub) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, num), sub ? h('div', { class: 'sub' }, sub) : null);
    const max = Math.max(1, ...o.signupSeries.map(s => s.count));
    const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'New customers per day, last 30 days' },
      o.signupSeries.map(s => { const i = h('i', { class: s.count ? '' : 'zero', title: `${s.date}: ${s.count}` }); i.style.height = Math.max(2, (s.count / max) * 85) + '%'; return h('div', { class: 'bar' }, h('span', { class: s.count ? '' : 'z' }, s.count), i); }));
    el.replaceChildren(
      head('Overview'),
      h('div', { class: 'cards' },
        stat('Revenue, last 30 days', moneyList(o.revenue30Days), `All time ${moneyList(o.revenueTotal)}`),
        stat('Customers', o.customers),
        stat('Active licences', o.licences.active, `${o.licences.activePaid} paid · ${o.licences.activeTrials} trial`),
        stat('Expiring in 7 days', o.licences.expiringIn7Days, `${o.licences.expired} expired · ${o.licences.revoked} cancelled`),
        stat('Computers seen, 7 days', o.devicesActive7Days),
        stat('Trial to paid', o.trialConversion.percent + '%', `${o.trialConversion.converted} of ${o.trialConversion.trialCustomers} trial customers`),
        stat('Open support', o.openMessages),
        stat('Refunded', moneyList(o.refundedTotal)),
        stat('Website visitors today', o.website.today, `${o.website.visitors7Days} in 7 days · ${o.website.visitors30Days} in 30 days`),
        stat('New opportunities', o.website.newOpportunities, `${o.website.demoRequests30Days} demo requests in 30 days`)),
      h('div', { class: 'grid2' },
        h('div', { class: 'card' }, h('h2', {}, 'New customers, last 30 days'), bars,
          h('div', { class: 'axis' }, h('span', {}, o.signupSeries[0].date), h('span', {}, o.signupSeries[29].date))),
        h('div', { class: 'card' }, h('h2', {}, 'Latest support messages'),
          o.recentMessages.length ? o.recentMessages.map(m => h('div', { class: 'list-item' }, h('span', {}, `${m.name} · ${m.topic}`), pill(m.status))) : h('p', { class: 'muted' }, 'No messages yet.'))),
      h('div', { class: 'card' }, h('h2', {}, 'Latest orders'),
        o.recentOrders.length ? o.recentOrders.map(r => h('div', { class: 'list-item' }, h('span', {}, `${r.customer_email} · ${r.plan}`), h('span', {}, money(r.amount_cents, r.currency), ' ', pill(r.status)))) : h('p', { class: 'muted' }, 'No orders yet.')));
  }

  // ---------- customers ----------
  let sectorList = [];   // the candidate sectors (domains), from the server
  const sectorLabel = id => (sectorList.find(s => s.id === id) || {}).label || '';
  async function customers(el, query = '') {
    const { customers: rows, sectors } = await get('/admin/api/customers?q=' + encodeURIComponent(query));
    sectorList = sectors || sectorList;
    el.replaceChildren(
      head('Customers', searchBox(v => customers(el, v), 'Search name, email, organisation', query),
        can('customers.write') ? h('button', { class: 'btn primary', onclick: () => customerForm(null, () => customers(el, query)) }, '+ New customer') : null),
      table([
        { label: 'Email', render: r => r.email }, { label: 'Name', render: r => r.name || '—' }, { label: 'Organisation', render: r => r.organisation || '—' }, { label: 'Sector', render: r => sectorLabel(r.sector) || '—' },
        { label: 'Licences', render: r => r.licence_count }, { label: 'Paid', render: r => money(r.paid_cents) }, { label: 'Joined', render: r => date(r.created_at) },
      ], rows, r => customerDetail(r.id, () => customers(el, query)), query ? 'No customers match your search.' : 'No customers yet. Add one, or record an order.'));
  }

  function customerForm(existing, done) {
    const f = h('div', {},
      field('Email', { name: 'email', type: 'email', required: true, value: existing ? existing.email : '' }),
      h('div', { class: 'row2' }, field('Name', { name: 'name', value: existing ? existing.name : '' }), field('Organisation', { name: 'organisation', value: existing ? existing.organisation : '' })),
      h('div', { class: 'row2' }, field('Country', { name: 'country', value: existing ? existing.country : '' }),
        field('Sector (domain)', { name: 'sector', type: 'select', options: [{ value: '', label: 'Not chosen yet' }].concat(sectorList.map(s => ({ value: s.id, label: s.label }))), value: existing ? existing.sector || '' : '' }, 'Decides which employers AI Job search reads. The candidate can also set it in My account.')),
      field('Notes (private)', { name: 'notes', type: 'textarea', value: existing ? existing.notes : '', maxlength: 2000 }));
    dialog(existing ? 'Edit customer' : 'New customer', f, [{
      label: 'Save', kind: 'primary',
      run: async () => { const ok = await guard(async () => { await (existing ? patch(`/admin/api/customers/${existing.id}`, values(f)) : post('/admin/api/customers', values(f))); return true; }); if (!ok) return true; toast('Saved'); done(); },
    }]);
  }

  /** The customer's website login (My account page): status, plus create / new password / turn off. */
  async function accountSection(c, reopen) {
    const { account: a } = await get(`/admin/api/customers/${c.id}/account`);
    const write = can('accounts.write');
    const status = !a.exists ? 'No login yet. Create one to let the customer see their licences, computers and classes on the website.'
      : a.disabled ? 'Login turned off: the customer cannot sign in.'
        : `Login active${a.mustChange ? ', waiting for the customer to choose their own password' : ''}. Last sign-in: ${a.lastLogin ? dateTime(a.lastLogin) : 'never'}.`;
    const act = action => guard(async () => {
      if (action === 'reset' && a.exists && !confirm('Make a new password? The old one stops working and the customer is signed out.')) return;
      const r = await post(`/admin/api/customers/${c.id}/account`, { action });
      if (action === 'reset') showLogin(c, r); else { toast(action === 'disable' ? 'Login turned off' : 'Login turned on'); reopen(); }
    });
    return h('div', {}, h('h3', { style: 'margin-top:14px' }, 'Website login'), h('p', { class: 'small' }, status),
      write ? h('div', { class: 'actions' },
        h('button', { class: 'btn sm primary', onclick: () => act('reset') }, a.exists ? 'New password' : 'Create login'),
        a.exists ? h('button', { class: 'btn sm' + (a.disabled ? '' : ' danger'), onclick: () => act(a.disabled ? 'enable' : 'disable') }, a.disabled ? 'Turn login on' : 'Turn login off') : null) : null);
  }

  /** The generated password, shown once, with a message ready to send to the customer. */
  function showLogin(c, r) {
    const where = r.siteUrl ? `${r.siteUrl}/login.html` : 'the website (Sign in, top right)';
    const message = `Hello ${c.name || ''},\n\nYour ShortlistPrep account is ready.\nSign in at: ${where}\nEmail: ${r.email}\nPassword: ${r.password}\n\nYou will be asked to choose your own password when you first sign in.`.replace('Hello ,', 'Hello,');
    dialog('Login created', h('div', {},
      h('p', {}, 'Send these details to the customer. The password is shown only now; make a new one if it is lost.'),
      h('dl', { class: 'kv' }, h('dt', {}, 'Email'), h('dd', { class: 'mono' }, r.email), h('dt', {}, 'Password'), h('dd', { class: 'mono', style: 'font-size:18px;font-weight:700' }, r.password),
        h('dt', {}, 'Sign in at'), h('dd', {}, where)),
      h('div', { class: 'msg-body' }, message)), [
      { label: 'Copy message', kind: 'primary', closes: false, run: async () => { try { await navigator.clipboard.writeText(message); toast('Copied'); } catch (_) { toast('Select the text and copy it', true); } return true; } },
      { label: 'Done', run: () => {} }]);
  }

  /** The customer's personalised interview questions (made in the Virtual Interview app or on the website), with their model answers. */
  async function interviewSection(customerId) {
    const { sets, intros = [] } = await get(`/admin/api/customers/${customerId}/interview`);
    const kinds = { personal: 'From the resume', scenario: 'Scenario' };
    const statusText = { supported: 'in resume', partly: 'partly in resume', not_in_resume: 'NOT in resume' };
    const introList = intros.length ? [h('h3', { style: 'margin-top:14px' }, `Tell me about yourself (${intros.length})`), ...intros.map(x => h('details', { class: 'list-item', style: 'display:block' },
      h('summary', {}, h('b', {}, (x.kind === 'attempt' && x.review ? `Score ${x.review.score}/10` : 'Guide') + ' · ' + x.resumeLabel + (x.role ? ' · ' + x.role : '') + (x.company ? ' · ' + x.company : '')), ` · ${dateTime(x.createdAt)} · ${x.source === 'app' ? 'Virtual Interview app' : 'website'}`),
      x.kind === 'attempt' && x.review ? h('div', { class: 'small' }, h('p', {}, x.review.verdict), h('p', { class: 'muted' }, 'Answer: ' + x.answer),
        h('ul', {}, x.review.claims.map(c => h('li', {}, `${c.claim} (${statusText[c.status] || c.status})${c.note ? ': ' + c.note : ''}`))),
        h('p', {}, h('b', {}, 'More impressive version: '), x.review.impressive))
        : h('ul', { class: 'small' }, ((x.guide && x.guide.points) || []).map(p => h('li', {}, `${p.label}: ${p.bullet}`)))))] : [];
    return h('div', {}, h('h3', { style: 'margin-top:14px' }, `Interview prep (${sets.length})`),
      sets.length ? sets.map(set => h('details', { class: 'list-item', style: 'display:block' },
        h('summary', {}, h('b', {}, set.resumeLabel + (set.role ? ' · ' + set.role : '')), ` · ${dateTime(set.createdAt)} · ${set.questions.length} questions · ${set.source === 'app' ? 'Virtual Interview app' : 'website'}`),
        h('ol', { class: 'small' }, set.questions.map(q => h('li', {}, h('span', { class: 'muted' }, kinds[q.kind] + ': '), q.question,
          q.resumeRef ? h('div', { class: 'muted' }, 'Resume: "' + q.resumeRef + '"') : null, h('div', { class: 'muted' }, 'Answer: ' + q.answer)))))) 
        : h('p', { class: 'muted small' }, 'No personalised question sets yet. They are made in the Virtual Interview app or in My account → Interview prep.'), ...introList);
  }

  async function customerDetail(id, done) {
    const d = await get(`/admin/api/customers/${id}`);
    const c = d.customer;
    sectorList = d.sectors || sectorList;
    let closeDetail = () => {};
    const login = await accountSection(c, () => { closeDetail(); customerDetail(id, done); });
    const interview = await interviewSection(c.id);
    const body = h('div', {},
      h('dl', { class: 'kv' }, h('dt', {}, 'Email'), h('dd', {}, c.email), h('dt', {}, 'Name'), h('dd', {}, c.name || '—'), h('dt', {}, 'Organisation'), h('dd', {}, c.organisation || '—'),
        h('dt', {}, 'Country'), h('dd', {}, c.country || '—'), h('dt', {}, 'Sector'), h('dd', {}, sectorLabel(c.sector) || 'Not chosen yet'), h('dt', {}, 'Joined'), h('dd', {}, dateTime(c.created_at)), h('dt', {}, 'Notes'), h('dd', {}, c.notes || '—')),
      h('h3', {}, 'Licences'),
      d.licences.length ? d.licences.map(l => h('div', { class: 'list-item' }, h('span', { class: 'mono' }, l.key), h('span', {}, `${l.plan} · `, pill(l.effective_status), ` · ${l.expires_at ? 'to ' + date(l.expires_at) : 'lifetime'}`))) : h('p', { class: 'muted' }, 'None.'),
      h('h3', { style: 'margin-top:14px' }, 'Orders'),
      d.orders.length ? d.orders.map(o => h('div', { class: 'list-item' }, h('span', {}, `#${o.id} · ${o.plan} · ${date(o.created_at)}`), h('span', {}, money(o.amount_cents, o.currency), ' ', pill(o.status)))) : h('p', { class: 'muted' }, 'None.'),
      interview, login);
    const buttons = [];
    if (can('licence.major')) buttons.push({ label: 'Issue licence', run: (close) => { close(); licenceForm(c.id, done); return true; }, closes: false });
    if (can('customers.write')) buttons.push({ label: 'Edit', run: (close) => { close(); customerForm(c, done); return true; }, closes: false });
    buttons.push({ label: 'Topics and resume', run: (close) => { close(); profileEditor(c.id, done); return true; }, closes: false });
    buttons.push({ label: 'Close', run: () => {} });
    closeDetail = dialog(c.name || c.email, body, buttons).close;
  }

  // ---------- licences ----------
  async function licences(el, query = '', status = '') {
    const { licences: rows } = await get(`/admin/api/licences?q=${encodeURIComponent(query)}&status=${status}`);
    const filter = h('select', { 'aria-label': 'Filter by status', onchange: e => licences(el, query, e.target.value) },
      [['', 'All'], ['active', 'Active'], ['trial', 'Active trials'], ['expired', 'Expired'], ['revoked', 'Cancelled']].map(([v, l]) => h('option', { value: v }, l)));
    filter.value = status;
    el.replaceChildren(
      head('Licences', searchBox(v => licences(el, v, status), 'Search key, email or name', query), filter,
        can('licence.major') ? h('button', { class: 'btn primary', onclick: () => licenceForm(null, () => licences(el, query, status)) }, '+ New licence') : null),
      table([
        { label: 'Key', render: r => h('span', { class: 'mono' }, r.key) }, { label: 'Customer', render: r => r.customer_email },
        { label: 'Plan', render: r => `${r.plan}${r.kind === 'trial' ? ' (trial)' : ''}` }, { label: 'Status', render: r => pill(r.effective_status) },
        { label: 'Expires', render: r => (r.expires_at ? date(r.expires_at) : 'Lifetime') }, { label: 'Computers', render: r => `${r.device_count} / ${r.max_devices}` },
      ], rows, r => licenceDetail(r.id, () => licences(el, query, status)), 'No licences found.'));
  }

  async function licenceForm(customerId, done) {
    const { customers: list } = await get('/admin/api/customers');
    if (!list.length) return toast('Add a customer first.', true);
    const f = h('div', {},
      field('Customer', { name: 'customerId', type: 'select', options: list.map(c => ({ value: c.id, label: `${c.email}${c.name ? ' · ' + c.name : ''}` })), value: customerId || list[0].id }),
      h('div', { class: 'row2' },
        field('Plan', { name: 'plan', type: 'select', options: [{ value: 'trial', label: 'Trial' }, { value: 'personal', label: 'Personal' }, { value: 'schools', label: 'Schools' }], value: 'trial' }),
        field('Valid for (days)', { name: 'days', type: 'number', min: 1, max: 3650, value: 14 }, 'Leave empty for lifetime. Trial 14, paid plans 365.')),
      field('Computers allowed', { name: 'maxDevices', type: 'number', min: 1, max: 100, placeholder: 'Plan default' }),
      field('Note (private)', { name: 'note', maxlength: 500 }));
    f.querySelector('[name=plan]').addEventListener('change', e => { f.querySelector('[name=days]').value = e.target.value === 'trial' ? 14 : 365; });
    dialog('New licence', f, [{
      label: 'Create licence', kind: 'primary', closes: false,
      run: async close => {
        const v = values(f);
        const res = await guard(() => post('/admin/api/licences', { customerId: Number(v.customerId), plan: v.plan, days: v.days === '' ? 'lifetime' : Number(v.days), maxDevices: v.maxDevices ? Number(v.maxDevices) : undefined, note: v.note }));
        if (!res) return true;
        close(); done();
        dialog('Licence created', h('div', {}, h('p', {}, 'Send this key to the customer:'), h('p', { class: 'mono', style: 'font-size:20px;font-weight:700' }, res.licence.key)), [{
          label: 'Copy key', run: async () => { try { await navigator.clipboard.writeText(res.licence.key); toast('Copied'); } catch (_) { toast('Select the key and copy it', true); } return true; }, closes: false,
        }, { label: 'Done', run: () => {} }]);
        return true;
      },
    }]);
  }

  async function licenceDetail(id, done) {
    const d = await get(`/admin/api/licences/${id}`);
    const l = d.licence;
    const aiSection = await licenceAiKeys(l, d.aiKeys);
    const act = (action, extra, message) => guard(async () => { await patch(`/admin/api/licences/${id}`, { action, ...extra }); toast(message || 'Done'); done(); });
    const body = h('div', {},
      h('dl', { class: 'kv' }, h('dt', {}, 'Key'), h('dd', { class: 'mono' }, l.key), h('dt', {}, 'Customer'), h('dd', {}, l.customer_email),
        h('dt', {}, 'Plan'), h('dd', {}, `${l.plan} (${l.kind})`), h('dt', {}, 'Status'), h('dd', {}, pill(l.effective_status)),
        h('dt', {}, 'Expires'), h('dd', {}, l.expires_at ? dateTime(l.expires_at) : 'Lifetime'), h('dt', {}, 'Computers allowed'), h('dd', {}, String(l.max_devices)),
        h('dt', {}, 'Created'), h('dd', {}, dateTime(l.created_at)), h('dt', {}, 'Note'), h('dd', {}, l.note || '—')),
      h('h3', {}, `Activated computers (${d.devices.length})`),
      d.devices.length ? d.devices.map(dev => h('div', { class: 'list-item' },
        h('span', {}, `${dev.name || 'Computer'} · v${dev.app_version || '?'} · last seen ${dateTime(dev.last_seen)}`),
        h('button', { class: 'btn sm', onclick: async () => { await act('removeDevice', { deviceId: dev.device_id }, 'Computer removed'); close(); } }, 'Remove'))) : h('p', { class: 'muted' }, 'Not activated on any computer yet.'),
      aiSection);
    const buttons = [];
    if (l.expires_at) buttons.push({ label: 'Extend…', run: () => extendPrompt(act), closes: false });
    buttons.push({ label: 'Reset computers', run: async () => { await act('resetDevices', {}, 'All computers removed'); } });
    if (can('licence.major')) {
      buttons.push({ label: 'Set limit…', run: () => limitPrompt(l, act), closes: false });
      buttons.push(l.status === 'revoked'
        ? { label: 'Reinstate', run: async () => { await act('reinstate', {}, 'Licence reinstated'); } }
        : { label: 'Cancel licence', kind: 'danger', run: async () => { if (confirm('Cancel this licence? The app stops working for the customer on its next check.')) await act('revoke', {}, 'Licence cancelled'); } });
    }
    buttons.push({ label: 'Close', run: () => {} });
    const { close } = dialog('Licence', body, buttons);
  }

  /** Which AI key this licence uses for each service: its own, or the default. Changes save straight away. */
  async function licenceAiKeys(l, aiKeys) {
    const { keys, providers } = await get('/admin/api/ai-keys');
    const describe = r => (r.source === 'none' ? 'no key: the app uses the computer\'s own key, if any'
      : `${r.key.label} (${r.key.masked})${r.source === 'default' ? ', the default' : ''}${r.assignedDisabled ? '. Its own key is turned off, so the default is used' : ''}`);
    const rows = providers.map(p => {
      const r = aiKeys[p.id];
      const now = h('span', { class: 'muted small' }, 'Uses ' + describe(r));
      const def = keys.find(k => k.provider === p.id && k.is_default);
      const select = h('select', { 'aria-label': p.label + ' key', disabled: !can('aikeys.write') },
        h('option', { value: '' }, `Default${def ? ' · ' + def.label + ' ' + def.masked : ' (none set)'}`),
        keys.filter(k => k.provider === p.id).map(k => h('option', { value: k.id }, `${k.label} ${k.masked}${k.disabled ? ' (off)' : ''}`)));
      select.value = r.assignedId ? String(r.assignedId) : '';
      select.addEventListener('change', () => guard(async () => {
        const res = await post(`/admin/api/licences/${l.id}/ai-keys`, { provider: p.id, apiKeyId: select.value ? Number(select.value) : null });
        now.textContent = 'Uses ' + describe(res.aiKeys[p.id]);
        toast(`${p.label} key saved`);
      }));
      return h('div', { class: 'list-item' }, h('span', {}, h('b', {}, p.label), ` · ${p.use}`, h('br'), now), select);
    });
    return h('div', {}, h('h3', { style: 'margin-top:14px' }, 'AI keys'), rows,
      h('p', { class: 'muted small' }, 'The app receives these keys at start-up and every 30 minutes while it runs.'));
  }

  // ---------- AI keys ----------
  async function aikeys(el) {
    const { keys, providers } = await get('/admin/api/ai-keys');
    const write = can('aikeys.write');
    const act = (k, action, extra, message) => guard(async () => { await patch(`/admin/api/ai-keys/${k.id}`, { action, ...extra }); toast(message); aikeys(el); });
    const tools = k => (write ? h('span', { class: 'tools' },
      !k.is_default && !k.disabled ? h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); act(k, 'default', {}, `${k.label} is now the default ${k.provider_label} key`); } }, 'Make default') : null,
      h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); replaceKey(k, () => aikeys(el)); } }, 'Replace'),
      h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); act(k, k.disabled ? 'enable' : 'disable', {}, k.disabled ? 'Key turned on' : 'Key turned off'); } }, k.disabled ? 'Turn on' : 'Turn off'),
      h('button', { class: 'btn sm danger', onclick: e => { e.stopPropagation(); if (confirm(`Delete "${k.label}"? Licences using it go back to the default ${k.provider_label} key.`)) guard(async () => { await del(`/admin/api/ai-keys/${k.id}`); toast('Key deleted'); aikeys(el); }); } }, 'Delete')) : '');
    const missing = providers.filter(p => !keys.some(k => k.provider === p.id && k.is_default && !k.disabled));
    el.replaceChildren(
      head('AI keys', write ? h('button', { class: 'btn primary', onclick: () => keyForm(providers, () => aikeys(el)) }, '+ Add key') : null),
      h('p', { class: 'muted' }, 'Keys the app uses: Groq writes the answers, Gemini reads screenshots. Each licence uses the default key of each service unless you give it its own key (open the licence, then "AI keys").'),
      missing.length ? h('div', { class: 'card', style: 'margin-bottom:14px' }, h('b', {}, 'No default key yet for: '), missing.map(p => p.label).join(', '),
        h('span', { class: 'muted' }, '. Licences without their own key get no key for that service.')) : '',
      table([
        { label: 'Service', render: r => `${r.provider_label} · ${providers.find(p => p.id === r.provider).use}` },
        { label: 'Name', render: r => r.label },
        { label: 'Key', render: r => h('span', { class: 'mono' }, r.masked) },
        { label: 'Default', render: r => (r.is_default ? pill('default') : '—') },
        { label: 'Status', render: r => (r.disabled ? pill('off') : pill('on')) },
        { label: 'Licences', render: r => r.licence_count },
        { label: 'Last used', render: r => dateTime(r.last_used_at) },
        { label: '', render: tools },
      ], keys, null, 'No AI keys yet. Add a Groq key for answers and a Gemini key for screenshots.'),
      h('p', { class: 'muted small' }, 'Keys are stored encrypted and only the last 4 characters are shown here.'));
  }

  function keyForm(providers, done) {
    const f = h('div', {},
      h('div', { class: 'row2' },
        field('Service', { name: 'provider', type: 'select', options: providers.map(p => ({ value: p.id, label: `${p.label} · ${p.use}` })) }),
        field('Name', { name: 'label', required: true, maxlength: 80, placeholder: 'e.g. Groq main account' })),
      field('Key', { name: 'key', type: 'password', required: true, maxlength: 300 }, 'Shown only as the last 4 characters after saving.'),
      h('label', { class: 'field' }, h('span', {}, h('input', { type: 'checkbox', name: 'makeDefault' }), ' Make this the default key for the service')));
    dialog('Add AI key', f, [{ label: 'Save key', kind: 'primary', run: async () => {
      const ok = await guard(async () => { await post('/admin/api/ai-keys', values(f)); return true; });
      if (!ok) return true;
      toast('Key saved'); done();
    } }]);
  }

  function replaceKey(k, done) {
    const f = field(`New ${k.provider_label} key`, { name: 'key', type: 'password', maxlength: 300 }, 'Licences using this key get the new one on their next check.');
    dialog(`Replace "${k.label}"`, f, [{ label: 'Replace', kind: 'primary', run: async () => {
      const ok = await guard(async () => { await patch(`/admin/api/ai-keys/${k.id}`, { action: 'replace', key: values(f).key }); return true; });
      if (!ok) return true;
      toast('Key replaced'); done();
    } }]);
  }

  function extendPrompt(act) {
    const f = field('Extend by (days)', { name: 'days', type: 'number', min: 1, max: 3650, value: 30 }, 'Counted from the current expiry, or from today if it has already expired.');
    dialog('Extend licence', f, [{ label: 'Extend', kind: 'primary', run: async () => { await act('extend', { days: Number(values(f).days) }, 'Licence extended'); } }]);
  }
  function limitPrompt(l, act) {
    const f = field('Computers allowed', { name: 'maxDevices', type: 'number', min: 1, max: 100, value: l.max_devices });
    dialog('Computers allowed', f, [{ label: 'Save', kind: 'primary', run: async () => { await act('setMaxDevices', { maxDevices: Number(values(f).maxDevices) }, 'Limit updated'); } }]);
  }

  // ---------- orders ----------
  async function orders(el, query = '') {
    const { orders: rows } = await get('/admin/api/orders?q=' + encodeURIComponent(query));
    el.replaceChildren(
      head('Orders', searchBox(v => orders(el, v), 'Search email or reference', query),
        can('orders.write') ? h('button', { class: 'btn primary', onclick: () => orderForm(() => orders(el, query)) }, '+ Record order') : null),
      table([
        { label: '#', render: r => r.id }, { label: 'Date', render: r => date(r.created_at) }, { label: 'Customer', render: r => r.customer_email },
        { label: 'Plan', render: r => r.plan }, { label: 'Amount', render: r => money(r.amount_cents, r.currency) }, { label: 'Status', render: r => pill(r.status) },
        { label: 'Source', render: r => `${r.provider}${r.provider_ref ? ' · ' + r.provider_ref : ''}` },
        { label: '', render: r => (r.status === 'paid' && can('orders.write') ? h('button', { class: 'btn sm danger', onclick: e => { e.stopPropagation(); refund(r, () => orders(el, query)); } }, 'Refund') : '') },
      ], rows, null, 'No orders yet. Record one when a payment arrives.'));
  }

  async function orderForm(done) {
    const { customers: list } = await get('/admin/api/customers');
    if (!list.length) return toast('Add a customer first.', true);
    const f = h('div', {},
      field('Customer', { name: 'customerId', type: 'select', options: list.map(c => ({ value: c.id, label: c.email })) }),
      h('div', { class: 'row2' }, field('Plan', { name: 'plan', type: 'select', options: [{ value: 'personal', label: 'Personal' }, { value: 'schools', label: 'Schools' }] }),
        field('Amount', { name: 'amount', type: 'number', min: 0, value: 9 }, 'In the main unit, for example 9.00')),
      h('div', { class: 'row2' }, field('Currency', { name: 'currency', value: 'USD', maxlength: 3 }), field('Reference', { name: 'providerRef', placeholder: 'Payment provider ID' })),
      h('label', { class: 'field' }, h('span', {}, h('input', { type: 'checkbox', name: 'issueLicence', checked: true }), ' Issue a licence for this order')));
    dialog('Record order', f, [{
      label: 'Save order', kind: 'primary', closes: false,
      run: async close => {
        const v = values(f);
        const res = await guard(() => post('/admin/api/orders', { customerId: Number(v.customerId), plan: v.plan, amountCents: Math.round(Number(v.amount) * 100), currency: v.currency, providerRef: v.providerRef, issueLicence: v.issueLicence }));
        if (!res) return true;
        close(); done();
        if (res.licence) dialog('Order saved', h('div', {}, h('p', {}, 'Licence key for the customer:'), h('p', { class: 'mono', style: 'font-size:20px;font-weight:700' }, res.licence.key)), [{ label: 'Done', run: () => {} }]);
        else toast('Order saved');
        return true;
      },
    }]);
  }

  function refund(order, done) {
    const f = h('div', {}, h('p', {}, `Mark order #${order.id} (${money(order.amount_cents, order.currency)}) as refunded.`, ' This only records it here; send the actual refund from your payment provider.'),
      h('label', { class: 'field' }, h('span', {}, h('input', { type: 'checkbox', name: 'revokeLicences', checked: true }), ' Also cancel the licence issued with this order')));
    dialog('Refund order', f, [{ label: 'Mark as refunded', kind: 'danger', run: async () => { await guard(async () => { await post(`/admin/api/orders/${order.id}/refund`, { revokeLicences: values(f).revokeLicences }); toast('Order refunded'); done(); }); } }]);
  }

  // ---------- releases ----------
  async function releases(el) {
    const { releases: rows } = await get('/admin/api/releases');
    el.replaceChildren(
      head('Releases', can('releases.write') ? h('button', { class: 'btn primary', onclick: () => releaseForm(() => releases(el)) }, '+ Publish release') : null),
      h('p', { class: 'muted' }, 'The desktop app asks the server for the newest release (GET /api/releases/latest) to offer updates.'),
      table([
        { label: 'Version', render: r => r.version }, { label: 'Channel', render: r => pill(r.channel) }, { label: 'Published', render: r => date(r.published_at) },
        { label: 'Minimum supported', render: r => r.min_supported || '—' }, { label: 'Notes', wrap: true, render: r => r.notes || '—' },
        { label: 'Download', render: r => (r.download_url ? h('a', { href: r.download_url, rel: 'noopener', target: '_blank' }, 'Link') : '—') },
        { label: '', render: r => (can('releases.write') ? h('button', { class: 'btn sm danger', onclick: () => { if (confirm(`Delete version ${r.version}?`)) guard(async () => { await del(`/admin/api/releases/${r.id}`); toast('Deleted'); releases(el); }); } }, 'Delete') : '') },
      ], rows, null, 'No releases published yet.'));
  }

  function releaseForm(done) {
    const f = h('div', {},
      h('div', { class: 'row2' }, field('Version', { name: 'version', required: true, placeholder: '1.0.0' }), field('Channel', { name: 'channel', type: 'select', options: [{ value: 'stable', label: 'Stable' }, { value: 'beta', label: 'Beta' }] })),
      field('Download link', { name: 'downloadUrl', placeholder: 'https://…' }, 'Must start with https://'),
      field('Minimum supported version', { name: 'minSupported', placeholder: '1.0.0' }, 'Older versions will be told to update.'),
      field('What changed', { name: 'notes', type: 'textarea', maxlength: 5000 }));
    dialog('Publish release', f, [{ label: 'Publish', kind: 'primary', run: async () => { const ok = await guard(async () => { await post('/admin/api/releases', values(f)); return true; }); if (!ok) return true; toast('Release published'); done(); } }]);
  }

  // ---------- support ----------
  async function messages(el, status = 'open') {
    const { messages: rows } = await get('/admin/api/messages?status=' + status);
    openCount = status === 'open' ? rows.length : openCount;
    const filter = h('select', { 'aria-label': 'Filter', onchange: e => messages(el, e.target.value) }, [['open', 'Open'], ['closed', 'Closed'], ['', 'All']].map(([v, l]) => h('option', { value: v }, l)));
    filter.value = status;
    el.replaceChildren(head('Support messages', filter), table([
      { label: 'Date', render: r => dateTime(r.created_at) }, { label: 'From', render: r => `${r.name} <${r.email}>` }, { label: 'Topic', render: r => r.topic },
      { label: 'Message', wrap: true, render: r => (r.body.length > 90 ? r.body.slice(0, 90) + '…' : r.body) }, { label: 'Status', render: r => pill(r.status) },
    ], rows, r => messageDetail(r, () => messages(el, status)), 'No messages.'));
  }

  function messageDetail(m, done) {
    const note = field('Private note', { name: 'note', type: 'textarea', value: m.note, maxlength: 2000 });
    const save = async status => { await guard(async () => { await patch(`/admin/api/messages/${m.id}`, { status, note: values(note).note }); toast('Saved'); done(); }); };
    dialog(`${m.topic} · ${m.name}`, h('div', {}, h('p', { class: 'muted small' }, `${m.email} · ${dateTime(m.created_at)}`), h('div', { class: 'msg-body' }, m.body), note,
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: `mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent('Re: ' + m.topic)}` }, 'Reply by email'))),
      [m.status === 'open' ? { label: 'Save and close ticket', kind: 'primary', run: () => save('closed') } : { label: 'Reopen', kind: 'primary', run: () => save('open') }, { label: 'Save note', run: () => save(m.status) }]);
  }

  // ---------- opportunities (demo requests and interest from the website) ----------
  const STAGES = ['new', 'contacted', 'qualified', 'won', 'lost'];
  const KIND_LABEL = { demo: 'Demo request', interest: 'Interested', signup: 'Early access', contact: 'Contact form' };
  async function opportunities(el, status = '', kind = '', query = '') {
    const { opportunities: rows, counts } = await get('/admin/api/opportunities?status=' + status + '&kind=' + kind + '&q=' + encodeURIComponent(query));
    newOppCount = counts.new;
    const redo = (s, k, q) => opportunities(el, s, k, q);
    const stageFilter = h('select', { 'aria-label': 'Stage', onchange: e => redo(e.target.value, kind, query) },
      [['', 'All stages'], ...STAGES.map(s => [s, s[0].toUpperCase() + s.slice(1) + ' (' + counts[s] + ')'])].map(([v, l]) => h('option', { value: v }, l)));
    stageFilter.value = status;
    const kindFilter = h('select', { 'aria-label': 'Type', onchange: e => redo(status, e.target.value, query) },
      [['', 'All types'], ...Object.entries(KIND_LABEL)].map(([v, l]) => h('option', { value: v }, l)));
    kindFilter.value = kind;
    el.replaceChildren(
      head('Opportunities', searchBox(v => redo(status, kind, v), 'Search name, email, company', query), kindFilter, stageFilter),
      h('div', { class: 'cards' }, STAGES.map(s => h('div', { class: 'card stat' }, h('div', { class: 'label' }, s), h('div', { class: 'num' }, counts[s])))),
      table([
        { label: 'Date', render: r => dateTime(r.created_at) }, { label: 'Who', render: r => (r.name ? r.name + ' <' + r.email + '>' : r.email) },
        { label: 'Type', render: r => KIND_LABEL[r.kind] }, { label: 'Company / college', render: r => r.company || '—' },
        { label: 'Stage', render: r => pill(r.status) }, { label: 'Follow up', render: r => r.follow_up || '—' },
      ], rows, r => opportunityDetail(r.id, () => redo(status, kind, query)), 'No opportunities yet. They appear here when someone asks for a demo or shows interest on the website.'));
  }

  async function opportunityDetail(id, done) {
    const { opportunity: o, notes, pages } = await get('/admin/api/opportunities/' + id);
    const write = can('opportunities.write');
    const stage = field('Stage', { name: 'status', type: 'select', value: o.status, options: STAGES.map(s => ({ value: s, label: s })) });
    const owner = field('Owner', { name: 'owner', value: o.owner, maxlength: 100 });
    const followUp = field('Follow up on', { name: 'followUp', type: 'date', value: o.follow_up });
    const worth = field('Deal value (USD)', { name: 'value', type: 'number', min: 0, value: String(o.value_cents / 100) });
    const note = field('Add a note', { name: 'note', type: 'textarea', maxlength: 2000 });
    const detail = (label, text) => h('p', { class: 'small' }, h('b', {}, label + ': '), text || '—');
    const body = h('div', {},
      detail('Type', KIND_LABEL[o.kind]), detail('Email', o.email), detail('Phone', o.phone), detail('Company / college', o.company),
      detail('Preparing for', o.role_interest), detail('Came from page', o.source_page), detail('First asked', dateTime(o.created_at)),
      o.message ? h('div', { class: 'msg-body' }, o.message) : null,
      write ? h('div', {}, stage, owner, followUp, worth, note) : null,
      pages.length ? h('div', {}, h('h2', {}, 'Pages this visitor viewed'), pages.map(p => h('div', { class: 'list-item' }, h('span', {}, p.path), h('span', { class: 'muted small' }, dateTime(p.at))))) : null,
      h('h2', {}, 'History'),
      notes.length ? notes.map(n => h('div', { class: 'list-item' }, h('span', {}, n.body), h('span', { class: 'muted small' }, n.author + ' · ' + dateTime(n.created_at)))) : h('p', { class: 'muted' }, 'No notes yet.'),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: 'mailto:' + encodeURIComponent(o.email) + '?subject=' + encodeURIComponent('Your ShortlistPrep ' + (o.kind === 'demo' ? 'demo' : 'request')) }, 'Reply by email')));
    const buttons = [];
    if (write) buttons.push({ label: 'Save', kind: 'primary', run: () => guard(async () => {
      const v = values(body);
      await patch('/admin/api/opportunities/' + o.id, { status: v.status, owner: v.owner, followUp: v.followUp, valueCents: Math.round(Number(v.value || 0) * 100), note: v.note });
      toast('Saved'); done();
    }) });
    if (can('customers.write') && !o.customer_id) buttons.push({ label: 'Make customer', run: () => guard(async () => { await post('/admin/api/opportunities/' + o.id + '/customer'); toast('Customer created'); done(); }) });
    dialog((KIND_LABEL[o.kind] || 'Opportunity') + ' · ' + (o.name || o.email), body, buttons);
  }

  // ---------- free ATS checks (resumes checked on the website) ----------
  async function atsChecks(el, query = '') {
    const { checks: rows, total, average } = await get('/admin/api/ats-checks?q=' + encodeURIComponent(query));
    const stat = (label, num) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, num));
    el.replaceChildren(
      head('ATS checks', searchBox(v => atsChecks(el, v), 'Search name, email, phone', query)),
      h('p', { class: 'muted' }, 'Everyone who checked their resume on the website. Each one is also an opportunity. Only the name, email, mobile number and result are kept, not the resume itself.'),
      h('div', { class: 'cards' }, stat('Resumes checked', total), stat('Average score', average + ' / 100')),
      table([
        { label: 'Date', render: r => dateTime(r.created_at) }, { label: 'Name', render: r => r.name || '—' }, { label: 'Email', render: r => r.email },
        { label: 'Mobile', render: r => r.phone || '—' }, { label: 'File', render: r => r.file_name || 'Pasted text' },
        { label: 'Score', render: r => h('span', { class: 'pill ' + (r.score >= 70 ? 'good' : r.score >= 45 ? 'warn' : 'bad') }, r.score + ' / 100') },
      ], rows, r => atsDetail(r.id), 'No resumes checked yet. They appear here when a visitor uses the free ATS checker.'));
  }

  async function atsDetail(id) {
    const { check: c } = await get('/admin/api/ats-checks/' + id);
    const detail = (label, text) => h('p', { class: 'small' }, h('b', {}, label + ': '), text || '—');
    dialog('ATS check · ' + (c.name || c.email), h('div', {},
      detail('Score', c.score + ' / 100'), detail('Verdict', c.result.verdict), detail('Email', c.email), detail('Mobile', c.phone), detail('File', c.file_name), detail('Checked', dateTime(c.created_at)),
      h('h2', {}, 'Fix first'), c.result.fixFirst.length ? c.result.fixFirst.map(t => h('div', { class: 'list-item' }, h('span', {}, t))) : h('p', { class: 'muted' }, 'Nothing major.'),
      h('h2', {}, 'All checks'), c.result.checks.map(k => h('div', { class: 'list-item' }, h('span', {}, k.name + ' · ' + k.detail), h('span', {}, h('span', { class: 'pill ' + ({ pass: 'good', warn: 'warn', fail: 'bad' }[k.status]) }, k.status), ' ' + k.points + '/' + k.weight))),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: 'mailto:' + encodeURIComponent(c.email) + '?subject=' + encodeURIComponent('Your ShortlistPrep ATS score: ' + c.score + '/100') }, 'Email them'))));
  }

  // ---------- 1-on-1 demo bookings (booked on the website) ----------
  const DEMO_STATUSES = ['booked', 'confirmed', 'completed', 'cancelled', 'no_show'];
  const demoLabel = s => s.replace('_', ' ').replace(/^./, c => c.toUpperCase());
  const slotText = d => new Date(d.slot_date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + d.slot_time + ' IST';
  async function demos(el, status = '', when = 'upcoming', query = '') {
    const { demos: rows, counts } = await get('/admin/api/demos?status=' + status + '&when=' + (status ? '' : when) + '&q=' + encodeURIComponent(query));
    newDemoCount = counts.booked;
    const redo = (s, w, q) => demos(el, s, w, q);
    const statusFilter = h('select', { 'aria-label': 'Status', onchange: e => redo(e.target.value, when, query) },
      [['', 'Upcoming only'], ...DEMO_STATUSES.map(s => [s, demoLabel(s) + ' (' + counts[s] + ')'])].map(([v, l]) => h('option', { value: v }, l)));
    statusFilter.value = status;
    el.replaceChildren(
      head('1-on-1 demos', searchBox(v => redo(status, when, v), 'Search name, email, phone', query), statusFilter),
      h('div', { class: 'cards' }, DEMO_STATUSES.map(s => h('div', { class: 'card stat' }, h('div', { class: 'label' }, demoLabel(s)), h('div', { class: 'num' }, counts[s])))),
      table([
        { label: 'Slot', render: slotText }, { label: 'Who', render: r => r.name + ' <' + r.email + '>' }, { label: 'Phone', render: r => r.phone || '—' },
        { label: 'Wants help with', render: r => r.goal || '—' }, { label: 'Assigned to', render: r => r.assigned_to || '—' },
        { label: 'Status', render: r => pill(demoLabel(r.status)) },
      ], rows, r => demoDetail(r, () => redo(status, when, query)), 'No demo bookings yet. They appear here when someone picks a slot on the website.'));
  }

  function demoDetail(d, done) {
    const write = can('demos.write');
    const detail = (label, text) => h('p', { class: 'small' }, h('b', {}, label + ': '), text || '—');
    const status = field('Status', { name: 'status', type: 'select', value: d.status, options: DEMO_STATUSES.map(s => ({ value: s, label: demoLabel(s) })) });
    const date = field('Date', { name: 'date', type: 'date', value: d.slot_date });
    const time = field('Start time (IST)', { name: 'time', type: 'select', value: d.slot_time, options: ['10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00', '18:00'].map(t => ({ value: t, label: t })) });
    const link = field('Meeting link (Google Meet, Zoom)', { name: 'meetingLink', value: d.meeting_link, maxlength: 300 });
    const assigned = field('Assigned to', { name: 'assignedTo', value: d.assigned_to, maxlength: 100 });
    const note = field('Internal note', { name: 'adminNote', type: 'textarea', value: d.admin_note, maxlength: 2000 });
    const body = h('div', {},
      detail('Slot', slotText(d)), detail('Email', d.email), detail('Phone / WhatsApp', d.phone), detail('Booked on', dateTime(d.created_at)), detail('Came from page', d.source_page),
      d.goal ? h('div', { class: 'msg-body' }, d.goal) : null,
      write ? h('div', {}, status, date, time, link, assigned, note) : detail('Meeting link', d.meeting_link),
      h('div', { class: 'actions' }, h('a', { class: 'btn', href: 'mailto:' + encodeURIComponent(d.email) + '?subject=' + encodeURIComponent('Your ShortlistPrep 1-on-1 demo') + '&body=' + encodeURIComponent('Hello ' + d.name + ',\n\nYour free 1-on-1 demo is booked for ' + slotText(d) + '.' + (d.meeting_link ? '\nJoin here: ' + d.meeting_link : '') + '\n\nShortlistPrep') }, 'Email confirmation')));
    const buttons = [];
    if (write) buttons.push({ label: 'Save', kind: 'primary', run: () => guard(async () => {
      await patch('/admin/api/demos/' + d.id, values(body));
      toast('Saved'); done();
    }) });
    dialog('Demo · ' + d.name, body, buttons);
  }

  // ---------- offer bar (the strip at the top of every website page) ----------
  const THEME_LABEL = { sun: 'Gold', purple: 'Purple', teal: 'Teal' };
  const localInput = iso => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const offerState = (o, nowIso) => (!o.active ? 'Off' : o.ends_at && o.ends_at <= nowIso ? 'Ended' : o.starts_at && o.starts_at > nowIso ? 'Scheduled' : 'Live');
  async function offers(el) {
    const { offers: rows, now: nowIso } = await get('/admin/api/offers');
    const write = can('offers.write');
    const redo = () => offers(el);
    el.replaceChildren(
      head('Offer bar', write ? h('button', { class: 'btn primary', onclick: () => offerForm(null, redo) }, '+ New offer') : null),
      h('p', { class: 'muted' }, 'The strip at the top of every website page. The newest offer that is switched on and inside its dates is shown, with a countdown and a copy button for the coupon code. Visitors can close it.'),
      table([
        { label: 'Offer', render: r => h('span', {}, h('b', {}, r.name), h('div', { class: 'muted small' }, r.message)), wrap: true },
        { label: 'Code', render: r => (r.code ? h('span', { class: 'mono' }, r.code) : '—') },
        { label: 'Starts', render: r => (r.starts_at ? dateTime(r.starts_at) : 'Now') }, { label: 'Ends', render: r => (r.ends_at ? dateTime(r.ends_at) : 'No end') },
        { label: 'Status', render: r => { const s = offerState(r, nowIso); return h('span', { class: 'pill ' + ({ Live: 'good', Scheduled: 'warn', Ended: '', Off: '' }[s]) }, s); } },
        { label: '', render: r => (write ? h('button', { class: 'btn sm danger', onclick: e => { e.stopPropagation(); if (confirm(`Delete the offer "${r.name}"?`)) guard(async () => { await del('/admin/api/offers/' + r.id); toast('Offer deleted'); redo(); }); } }, 'Delete') : '') },
      ], rows, write ? r => offerForm(r, redo) : null, 'No offers yet. Add one to show a strip with a coupon code at the top of the website.'));
  }

  function offerForm(o, done) {
    const f = h('div', {},
      field('Offer name (only you see this)', { name: 'name', value: o ? o.name : '', maxlength: 80, placeholder: 'Diwali sale' }),
      field('Message shown on the website', { name: 'message', value: o ? o.message : '', maxlength: 200, placeholder: 'Diwali is almost here: 25% off every plan until 12 November with code DIWALI25.' }),
      field('Coupon code (optional, shows a copy button)', { name: 'code', value: o ? o.code : '', maxlength: 30, placeholder: 'DIWALI25' }),
      field('Button text (optional)', { name: 'ctaLabel', value: o ? o.cta_label : '', maxlength: 40, placeholder: 'Get 25% off' }),
      field('Button link', { name: 'ctaUrl', value: o ? o.cta_url : '', maxlength: 300, placeholder: 'pricing.html' }),
      field('Starts (leave empty to start now)', { name: 'startsAt', type: 'datetime-local', value: o ? localInput(o.starts_at) : '' }),
      field('Ends (leave empty for no end; a countdown shows until then)', { name: 'endsAt', type: 'datetime-local', value: o ? localInput(o.ends_at) : '' }),
      field('Colour', { name: 'theme', type: 'select', value: o ? o.theme : 'sun', options: Object.entries(THEME_LABEL).map(([value, label]) => ({ value, label })) }),
      field('Show on the website', { name: 'active', type: 'select', value: o ? String(o.active) : '1', options: [{ value: '1', label: 'On' }, { value: '0', label: 'Off' }] }),
      field('Visitors can close it', { name: 'dismissible', type: 'select', value: o ? String(o.dismissible) : '1', options: [{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }] }),
      h('p', { class: 'muted small' }, 'The coupon code is only displayed here. Make sure the code is accepted wherever you take payment.'));
    dialog(o ? 'Edit offer' : 'New offer', f, [{ label: 'Save', kind: 'primary', run: async () => {
      const ok = await guard(async () => {
        const v = values(f);
        const body = { ...v, active: v.active === '1', dismissible: v.dismissible === '1', startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : '', endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : '' };
        if (o) await patch('/admin/api/offers/' + o.id, body); else await post('/admin/api/offers', body);
        return true;
      });
      if (!ok) return true;
      toast('Offer saved'); done();
    } }]);
  }

  // ---------- website visits ----------
  async function visitors(el, days = 30) {
    const a = await get('/admin/api/analytics?days=' + days);
    const range = h('select', { 'aria-label': 'Period', onchange: e => visitors(el, Number(e.target.value)) }, [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']].map(([v, l]) => h('option', { value: v }, l)));
    range.value = String(days);
    const stat = (label, num, sub) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, num), sub ? h('div', { class: 'sub' }, sub) : null);
    const max = Math.max(1, ...a.series.map(s => s.visitors));
    const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'Visitors per day' },
      a.series.map(s => { const i = h('i', { class: s.visitors ? '' : 'zero', title: s.date + ': ' + s.visitors + ' visitors, ' + s.views + ' page views' }); i.style.height = Math.max(2, (s.visitors / max) * 85) + '%'; return h('div', { class: 'bar' }, h('span', { class: s.visitors ? '' : 'z' }, s.visitors), i); }));
    const list = (title, rows, empty) => h('div', { class: 'card' }, h('h2', {}, title),
      rows.length ? rows.map(r => h('div', { class: 'list-item' }, h('span', {}, r.name || r.path), h('span', {}, r.visitors + (r.views !== undefined ? ' visitors · ' + r.views + ' views' : ' visitors')))) : h('p', { class: 'muted' }, empty));
    el.replaceChildren(
      head('Website visits', range),
      h('div', { class: 'cards' },
        stat('Visitors', a.visitors, 'people, not page loads'), stat('Page views', a.views), stat('Today', a.today.visitors, a.today.views + ' page views'),
        stat('Returning visitors', a.returning, 'came on more than one day'), stat('Opportunities', a.opportunities, 'demo and interest requests'), stat('Visitor to opportunity', a.conversionPercent + '%')),
      h('div', { class: 'card' }, h('h2', {}, 'Visitors per day'), bars, h('div', { class: 'axis' }, h('span', {}, a.series[0].date), h('span', {}, a.series[a.series.length - 1].date))),
      h('div', { class: 'grid2' }, list('Top pages', a.topPages, 'No visits recorded yet.'), list('Where visitors come from', a.referrers, 'No visits recorded yet.')),
      h('div', { class: 'grid2' }, list('Devices', a.devices, 'No visits recorded yet.'), list('Campaign sources (utm_source)', a.sources, 'None yet. Add ?utm_source=name to a link you share.')),
      h('p', { class: 'muted small' }, 'Visits are counted without cookies or IP addresses: each browser keeps a random id. Search-engine bots and visitors who send "Do Not Track" are not counted.'));
  }

  // ---------- topics and resume per customer (ShortlistPrep.AI's AI uses them to choose the area of its answers) ----------
  async function profiles(el, query = '') {
    const { customers: all } = await get('/admin/api/profiles');
    const term = query.trim().toLowerCase();
    const rows = term ? all.filter(r => [r.email, r.name, r.organisation, ...r.topics].join(' ').toLowerCase().includes(term)) : all;
    el.replaceChildren(
      head('Topics and resume', searchBox(v => profiles(el, v), 'Search customer or topic', query)),
      h('p', { class: 'muted' }, 'Set what each customer\'s questions are about. ShortlistPrep.AI receives the topics and the resume with its licence check (at start and every 30 minutes), and the AI uses them to decide the area of its answers.'),
      table([
        { label: 'Customer', render: r => (r.name ? `${r.name} <${r.email}>` : r.email) },
        { label: 'Topics', wrap: true, render: r => (r.topics.length ? r.topics.join(', ') : h('span', { class: 'muted' }, 'none')) },
        { label: 'Resume', render: r => (r.resume_chars ? (r.resume_name || 'pasted text') + ` · ${r.resume_chars.toLocaleString()} characters` : h('span', { class: 'muted' }, 'none')) },
        { label: 'Updated', render: r => dateTime(r.updated_at) },
      ], rows, r => profileEditor(r.id, () => profiles(el, query)), term ? 'No customers match.' : 'No customers yet. Add one on the Customers page.'));
  }

  /** Text from a resume file: .txt / .md read here, .docx unzipped here, .pdf read by the server (Gemini). */
  async function resumeFromFile(file) {
    const name = file.name.toLowerCase();
    if (file.size > 5 * 1024 * 1024) throw new Error('The file is larger than 5 MB');
    if (/\.(txt|md|text)$/.test(name)) return file.text();
    if (name.endsWith('.docx')) return docxText(await file.arrayBuffer());
    if (name.endsWith('.pdf')) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return (await post('/admin/api/resume-text', { data: btoa(bin) })).text;
    }
    throw new Error('Choose a .pdf, .docx or .txt file, or paste the text');
  }

  /** The text of a Word .docx file: word/document.xml from the zip, paragraphs as lines. */
  async function docxText(buffer) {
    const view = new DataView(buffer);
    let end = buffer.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;   // end of the zip's file list
    if (end < 0) throw new Error('This is not a valid .docx file');
    let at = view.getUint32(end + 16, true);
    for (let n = view.getUint16(end + 10, true); n > 0; n--) {
      const method = view.getUint16(at + 10, true), size = view.getUint32(at + 20, true);
      const nameLen = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const fileName = new TextDecoder().decode(new Uint8Array(buffer, at + 46, nameLen));
      if (fileName === 'word/document.xml') {
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const raw = new Uint8Array(buffer, start, size);
        const xml = method === 0 ? new TextDecoder().decode(raw)
          : await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        return [...doc.getElementsByTagName('w:p')].map(p => [...p.getElementsByTagName('w:t')].map(t => t.textContent).join('')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      }
      at += 46 + nameLen + extra + comment;
    }
    throw new Error('No text was found in this .docx file');
  }

  async function profileEditor(customerId, done) {
    const { customer: c, profile: p } = await get(`/admin/api/customers/${customerId}/profile`);
    const write = can('profiles.write');
    let resumeName = p.resumeName;
    const topics = field('Topics', { name: 'topics', type: 'textarea', value: p.topics.join('\n'), maxlength: 3500 },
      'One per line, for example: Power Apps, Dataverse security, React hooks. Questions are expected to be about these areas.');
    const resume = h('textarea', { name: 'resume', maxlength: 20000, placeholder: 'Paste the resume text here, or choose a file above.', 'aria-label': 'Resume text' }, p.resume);
    resume.style.minHeight = '260px';
    const count = h('span', { class: 'hint' });
    const fileNote = h('span', { class: 'hint' }, resumeName ? 'From ' + resumeName : '');
    const showCount = () => { count.textContent = `${resume.value.length.toLocaleString()} / 20,000 characters. The AI reads the first 6,000.`; };
    resume.addEventListener('input', showCount); showCount();
    const picker = h('input', { type: 'file', accept: '.pdf,.docx,.txt,.md', 'aria-label': 'Resume file' });
    picker.addEventListener('change', () => guard(async () => {
      const file = picker.files[0];
      if (!file) return;
      fileNote.textContent = `Reading ${file.name}…`;
      try {
        resume.value = (await resumeFromFile(file)).slice(0, 20000);
        resumeName = file.name;
        fileNote.textContent = `From ${file.name}. Check the text, then press Save.`;
        showCount();
      } catch (err) { fileNote.textContent = ''; throw err; } finally { picker.value = ''; }
    }));
    const body = h('div', {},
      h('p', { class: 'muted small' }, `${c.email}${p.updatedAt ? ` · last changed ${dateTime(p.updatedAt)} by ${p.updatedBy}` : ''}`),
      topics,
      h('label', { class: 'field' }, 'Resume', write ? picker : null, fileNote, resume, count),
      h('p', { class: 'muted small' }, 'ShortlistPrep.AI gets the changes on its next licence check: when it starts, or within 30 minutes while it runs.'));
    if (!write) body.querySelectorAll('textarea').forEach(t => { t.readOnly = true; });
    const buttons = write ? [{ label: 'Save', kind: 'primary', run: async () => {
      const ok = await guard(async () => {
        const v = values(body);
        await post(`/admin/api/customers/${c.id}/profile`, { topics: v.topics, resume: v.resume, resumeName: v.resume.trim() ? resumeName : '' });
        return true;
      });
      if (!ok) return true;
      toast('Saved'); done();
    } }, { label: 'Clear resume', run: () => { resume.value = ''; resumeName = ''; fileNote.textContent = ''; showCount(); return true; }, closes: false }] : [];
    buttons.push({ label: write ? 'Cancel' : 'Close', run: () => {} });
    dialog(`Topics and resume · ${c.name || c.email}`, body, buttons).el.classList.add('wide');
  }

  // ---------- Candidates: progress, documents and activity in My account and the Career toolkit ----------
  const STEP_NAMES = [['resume', 'Resume'], ['ats', 'ATS check'], ['versions', 'Role resumes'], ['matches', 'Job match'], ['searches', 'AI job search']];
  const ACTION_LABEL = {
    login: '🔑 Signed in', 'resume.uploaded': '📄 Uploaded resume', 'resume.pdf_read': '📄 PDF read', 'ats.checked': '✅ ATS check',
    'version.created': '🧩 Role resume created', 'version.deleted': '🗑 Role resume deleted', 'match.created': '✉️ Job match & cover letter',
    'match.deleted': '🗑 Job match deleted', 'jobsearch.started': '🎯 AI job search started', 'jobsearch.done': '🎯 AI job search finished',
    'jobsearch.failed': '⚠️ AI job search failed', 'jobprep.created': '💡 Opened Insight for a job', 'tokens.claimed': '⚡ Asked for more AI tokens', 'tokens.granted': '⚡ Got AI tokens', download: '⬇️ Downloaded',
  };
  const scorePill = n => (n == null ? '—' : h('span', { class: 'pill ' + (n >= 75 ? 'good' : n >= 50 ? 'warn' : 'bad') }, String(n)));
  const progressDots = steps => h('span', { class: 'cand-dots', title: STEP_NAMES.map(([k, l]) => `${steps[k] ? '✓' : '·'} ${l}`).join('\n') },
    STEP_NAMES.map(([k, l]) => h('i', { class: steps[k] ? 'on' : '', 'aria-label': `${l}: ${steps[k] ? 'done' : 'not yet'}` })));
  const ago = s => {
    if (!s) return '—';
    const m = Math.floor((Date.now() - Date.parse(s)) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : m < 43200 ? `${Math.floor(m / 1440)} days ago` : date(s);
  };
  const dlLink = (id, kind, docId, label) => h('a', { class: 'btn sm', href: `/admin/api/candidates/${id}/download?kind=${kind}${docId ? '&id=' + docId : ''}`, download: '' }, '⬇ ' + label);

  async function candidates(el, state = { q: '', filter: '' }) {
    const d = await get(`/admin/api/candidates?q=${encodeURIComponent(state.q)}&filter=${state.filter}`);
    const stat = (label, num, sub) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, num ?? 0), sub ? h('div', { class: 'sub' }, sub) : null);
    const redo = change => candidates(el, { ...state, ...change });
    const filter = h('select', { 'aria-label': 'Show', onchange: e => redo({ filter: e.target.value }) },
      [['', 'All candidates'], ['resume', 'Uploaded a resume'], ['noresume', 'No resume yet'], ['searching', 'Ran an AI job search'], ['active', 'Active in the last 7 days']]
        .map(([v, l]) => h('option', { value: v }, l)));
    filter.value = state.filter;
    el.replaceChildren(
      head('Candidates', filter, searchBox(v => redo({ q: v }), 'Search name, email, organisation', state.q)),
      h('p', { class: 'muted' }, 'Customers using My account and the Career toolkit on the website: how far they got, their documents, job searches and what they did. Click a candidate for the details.'),
      h('div', { class: 'cards' }, stat('Candidates', d.stats.total), stat('Uploaded a resume', d.stats.withResume, `${d.stats.atsDone} ran the ATS check`),
        stat('Active in 7 days', d.stats.activeWeek), stat('AI job searches (7 days)', d.stats.searchesWeek)),
      table([
        { label: 'Candidate', render: r => h('span', {}, h('b', {}, r.name || r.email), h('br'), h('span', { class: 'small muted' }, r.name ? r.email : (r.organisation || ''))) },
        { label: 'Progress', render: r => h('span', { class: 'cand-progress' }, progressDots(r.steps), h('span', { class: 'small muted' }, `${r.done}/5`)) },
        { label: 'Resume', render: r => (r.resume ? h('span', {}, '✓ ', h('span', { class: 'small' }, r.resume.fileName || 'Pasted')) : h('span', { class: 'muted' }, 'Not yet')) },
        { label: 'ATS', render: r => scorePill(r.resume && r.resume.atsScore) },
        { label: 'Role resumes', render: r => String(r.versions) },
        { label: 'Job matches', render: r => String(r.matches) },
        { label: 'Job searches', render: r => String(r.searches) },
        { label: 'AI actions', render: r => String(r.aiActions) },
        { label: 'Login', render: r => (!r.login.exists ? pill('none') : r.login.disabled ? pill('off') : h('span', { class: 'small' }, r.login.lastLogin ? ago(r.login.lastLogin) : 'never')) },
        { label: 'Last active', render: r => h('span', { title: dateTime(r.lastActive) }, ago(r.lastActive)) },
      ], d.candidates, r => candidateDetail(el, r.id, () => candidates(el, state)),
      state.q || state.filter ? 'No candidates match.' : 'No candidates yet. They appear here once a customer has a website login or uses the Career toolkit.'));
  }

  async function candidateDetail(el, id, back) {
    const d = await get(`/admin/api/candidates/${id}`);
    const c = d.candidate;
    const section = (title, ...body) => h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, title), ...body);
    const tracker = h('ol', { class: 'cand-track' }, STEP_NAMES.map(([k, l], i) => h('li', { class: c.steps[k] ? 'on' : '' }, h('b', {}, c.steps[k] ? '✓' : String(i + 1)), l)));
    const r = d.resume;
    const results = h('div', {});

    const showSearch = async s => {
      const { search } = await get(`/admin/api/candidates/${id}/searches/${s.id}`);
      const res = search.result;
      if (!res) { results.replaceChildren(h('p', { class: 'muted' }, search.error || 'No results.')); return; }
      const groups = [['high', 'High probability: apply first'], ['medium', 'Medium probability'], ['stretch', 'Low probability: stretch']];
      results.replaceChildren(h('div', { class: 'cand-results' },
        h('h3', {}, `Results of ${dateTime(search.createdAt)}`),
        h('p', { class: 'small' }, h('b', {}, 'AI profile: '), [res.profile.level, res.profile.summary].filter(Boolean).join(' · ')),
        res.profile.targetRoles.length ? h('p', { class: 'small' }, h('b', {}, 'Best-fit roles: '), res.profile.targetRoles.join(', ')) : null,
        h('p', { class: 'small muted' }, `${res.jobs.length} matches from ${res.coverage.live} live jobs at ${res.coverage.companies} companies` +
          (res.coverage.notFound.length ? ` · not found: ${res.coverage.notFound.join(', ')}` : '')),
        groups.map(([b, label]) => {
          const list = res.jobs.filter(j => j.bucket === b);
          return list.length ? [h('h4', {}, `${label} (${list.length})`), table([
            { label: 'Fit', render: j => scorePill(j.score) },
            { label: 'Role', render: j => h('b', {}, j.title), wrap: true }, { label: 'Company', render: j => j.company },
            { label: 'Location', render: j => j.location || j.country || '—', wrap: true },
            { label: 'Why / gap', render: j => h('span', { class: 'small' }, j.why, j.gap && !/^none\.?$/i.test(j.gap) ? h('span', { class: 'muted' }, ` · Gap: ${j.gap}`) : null), wrap: true },
            { label: '', render: j => h('a', { href: j.url, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'Open ↗') },
          ], list)] : null;
        }),
        res.profile.resumeFixes.length ? [h('h4', {}, 'Resume fixes suggested'), h('ul', { class: 'small' }, res.profile.resumeFixes.map(f => h('li', {}, f)))] : null));
      results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const maxUse = Math.max(1, ...d.usage.map(u => u.count));

    // Prepare-for-this-job plans the candidate made (saved in career_job_preps)
    const prepBox = h('div', {});
    const MX = { match: ['✓ Match', 'good'], partial: ['◐ Partial', 'warn'], missing: ['✕ Missing', 'bad'] };
    const showPrep = async x => {
      const { prep } = await get(`/admin/api/candidates/${id}/preps/${x.id}`);
      const p = prep.plan || {};
      const linkList = links => h('span', { class: 'cand-links' }, (links || []).map(l => h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, l.label)));
      prepBox.replaceChildren(h('div', { class: 'cand-results' },
        h('h3', {}, `${prep.jobTitle} at ${prep.company}`, ' ', h('span', { class: 'small muted' }, `fit ${prep.fit} · prepared ${dateTime(prep.createdAt)}`)),
        p.summary ? h('p', { class: 'small' }, p.summary) : null,
        p.matrix ? [h('h4', {}, `Skill matrix · weighted skill score ${p.matrix.score}/100`), table([
          { label: 'Required', render: r => h('b', {}, r.skill) },
          { label: 'Type', render: r => (r.type ? `${r.type === 'functional' ? 'Functional' : 'Technical'}${r.priority === 'nice' ? ' · nice to have' : ''}` : '—') },
          { label: 'Weight', render: r => `${r.weight}%` },
          { label: 'Candidate', render: r => h('span', { class: 'pill ' + MX[r.status][1] }, MX[r.status][0]) },
          { label: 'Evidence', render: r => h('span', { class: 'small' }, r.evidence || '—'), wrap: true },
          { label: 'Score', render: r => `${r.earned} / ${r.weight}` }, { label: 'Gap', render: r => (r.missing ? `−${r.missing}` : '—') },
        ], p.matrix.rows)] : null,
        (p.gaps || []).length ? [h('h4', {}, `Gaps to close (+${p.gapPoints} fit)`), table([
          { label: 'Skill', render: g => h('b', {}, g.skill) }, { label: 'Points', render: g => `+${g.points}` },
          { label: 'Importance', render: g => pill(g.importance === 'high' ? 'failed' : g.importance === 'low' ? 'active' : 'expired') },
          { label: 'How to close it', render: g => h('span', { class: 'small' }, g.howToClose || g.why || '—', g.hours ? h('span', { class: 'muted' }, ` · ~${g.hours} h`) : null), wrap: true },
          { label: 'Learning links', render: g => linkList(g.links.concat(g.certification ? [{ label: g.certification.name, url: g.certification.url }] : [])), wrap: true },
        ], p.gaps)] : null,
        (p.plan || []).length ? [h('h4', {}, 'Plan to a full fit'), h('ol', { class: 'small' }, p.plan.map(x => h('li', {}, x)))] : null,
        (p.interviewQuestions || []).length ? [h('h4', {}, 'Interview questions'), h('ol', { class: 'small' }, p.interviewQuestions.map(x => typeof x === 'string' ? h('li', {}, x)
          : h('li', {}, h('span', { class: 'muted' }, ({ mcq: 'MCQ', short: 'Short', scenario: 'Scenario' })[x.type] + ': '), x.question,
            x.options ? h('div', {}, x.options.map((o, i) => h('div', {}, 'ABCD'[i] + '. ' + o + (i === x.correct ? '  ✓' : '')))) : null,
            h('div', { class: 'muted' }, 'Answer: ' + x.answer))))] : null,
        (p.tips || []).length ? [h('h4', {}, 'Tips'), h('ul', { class: 'small' }, p.tips.map(x => h('li', {}, x)))] : null));
      prepBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    el.replaceChildren(
      head(c.name || c.email, h('button', { class: 'btn', onclick: back }, '← All candidates')),
      h('div', { class: 'card' },
        h('dl', { class: 'kv' },
          h('dt', {}, 'Email'), h('dd', {}, c.email), h('dt', {}, 'Organisation'), h('dd', {}, c.organisation || '—'), h('dt', {}, 'Sector'), h('dd', {}, c.sectorLabel || 'Not chosen yet'),
          h('dt', {}, 'Website login'), h('dd', {}, !c.login.exists ? 'No login yet' : c.login.disabled ? 'Turned off' : `Active · last sign-in ${c.login.lastLogin ? dateTime(c.login.lastLogin) : 'never'}`),
          h('dt', {}, 'Last active'), h('dd', {}, c.lastActive ? `${dateTime(c.lastActive)} (${ago(c.lastActive)})` : '—'),
          h('dt', {}, 'AI actions'), h('dd', {}, `${c.aiActions || 0} in total`)),
        h('div', { class: 'small muted', style: 'margin-bottom:6px' }, `Career toolkit progress: ${c.done} of 5 steps`), tracker),

      section('Plan and usage', (() => {
        const e = d.entitlements, wrap = h('div', {});
        const rows = e.limits.map(l => h('div', { class: 'list-item' }, h('span', {}, l.label),
          h('span', {}, l.limit == null ? String(l.used) : l.used + ' of ' + l.limit, l.limit != null && l.pct >= 100 ? h('span', { class: 'pill bad', style: 'margin-left:8px' }, 'limit reached') : null)));
        const now = h('p', {}, h('b', {}, e.plan.name), ' ', e.plan.free ? h('span', { class: 'pill' }, 'no paid plan') : h('span', { class: 'pill good' }, 'until ' + date(e.plan.endsAt)),
          h('span', { class: 'muted small' }, e.plan.dailyTokens ? '  · ' + e.plan.dailyTokens.toLocaleString('en-IN') + ' AI tokens a day' : ''));
        const reload = () => candidateDetail(el, id, back);
        const tools = can('pricing.write') ? h('div', { class: 'actions' },
          h('button', { class: 'btn sm', onclick: () => guard(async () => {
            const p = await get('/admin/api/pricing');
            const f = h('div', {}, field('Plan', { name: 'planId', type: 'select', options: p.plans.filter(x => !x.archived).map(x => ({ value: x.id, label: x.name + ' · ₹' + x.price })) }),
              field('Days (optional)', { name: 'days', type: 'number', min: 1, max: 3650 }, 'Leave empty for the length of the plan.'));
            dialog('Give a plan to ' + (c.name || c.email), f, [{ label: 'Give plan', kind: 'primary', run: () => guard(async () => {
              const v = values(f); await post('/admin/api/candidates/' + id + '/plan', { planId: Number(v.planId), days: v.days ? Number(v.days) : undefined }); toast('Plan given'); reload(); }) }]);
          }) }, 'Give a plan'),
          !e.plan.free ? h('button', { class: 'btn sm danger', onclick: () => guard(async () => { await post('/admin/api/candidates/' + id + '/plan', { action: 'end' }); toast('Plan ended'); reload(); }) }, 'End plan') : null) : null;
        wrap.append(now, ...rows, tools);
        if (d.planOrders.length) wrap.append(h('h3', { style: 'margin-top:12px' }, 'Plan orders'), table([
          { label: 'Order', render: o => o.number || '#' + o.id }, { label: 'Plan', render: o => o.plan_name }, { label: 'Amount', render: o => money(o.amount_paise, 'INR') },
          { label: 'Status', render: o => pill(o.status) }, { label: 'Date', render: o => date(o.created_at) }], d.planOrders));
        return wrap;
      })()),

      section('Resume',
        !r ? h('p', { class: 'muted' }, 'No resume uploaded yet.') : h('div', {},
          h('p', {}, h('b', {}, r.fileName || 'Pasted resume'), h('span', { class: 'muted' }, ` · ${r.chars.toLocaleString()} characters · uploaded ${dateTime(r.uploadedAt)}`)),
          h('div', { class: 'actions' }, dlLink(id, 'original', null, 'Uploaded resume (.txt)'), r.ats && r.ats.improved ? dlLink(id, 'ats', null, 'ATS-friendly resume (.docx)') : null),
          h('details', {}, h('summary', { class: 'small' }, 'Preview the uploaded text'), h('pre', { class: 'mono small', style: 'white-space:pre-wrap' }, r.preview + (r.chars > r.preview.length ? '\n…' : ''))),
          r.ats ? h('div', { class: 'cand-ats' },
            h('h3', {}, 'ATS check ', scorePill(r.ats.score), r.ats.afterScore != null ? [' → ', scorePill(r.ats.afterScore)] : '', h('span', { class: 'small muted' }, `  ${dateTime(r.ats.checkedAt)}`)),
            h('p', { class: 'small' }, r.ats.verdict),
            r.ats.checks.length ? h('ul', { class: 'small cand-checks' }, r.ats.checks.map(k => h('li', { class: k.status }, h('b', {}, k.name + ': '), k.detail))) : null,
            r.ats.keywords.missing.length ? h('p', { class: 'small' }, h('b', {}, 'Missing keywords: '), r.ats.keywords.missing.join(', ')) : null,
            r.ats.suggestedRoles.length ? h('p', { class: 'small' }, h('b', {}, 'Suggested roles: '), r.ats.suggestedRoles.join(', ')) : null)
            : h('p', { class: 'small muted' }, 'ATS check not run yet.'))),

      section(`Role-based resumes (${d.versions.length})`, table([
        { label: 'Role', render: v => h('b', {}, v.role) }, { label: 'Fit', render: v => scorePill(v.fitScore) },
        { label: 'Note', render: v => h('span', { class: 'small' }, v.fitNote || '—'), wrap: true }, { label: 'Created', render: v => dateTime(v.createdAt) },
        { label: '', render: v => dlLink(id, 'version', v.id, '.docx') },
      ], d.versions, null, 'No role-based resumes yet.')),

      section(`Job matches & cover letters (${d.matches.length})`, table([
        { label: 'Job', render: m => h('b', {}, [m.jobTitle, m.company].filter(Boolean).join(' at ') || 'Job') }, { label: 'Score', render: m => scorePill(m.score) },
        { label: 'Verdict', render: m => h('span', { class: 'small' }, m.verdict || '—'), wrap: true }, { label: 'Created', render: m => dateTime(m.createdAt) },
        { label: '', render: m => (m.hasLetter ? dlLink(id, 'letter', m.id, 'Cover letter') : '—') },
      ], d.matches, null, 'No job matches yet.')),

      section(`AI job searches (${d.searches.length})`,
        table([
          { label: 'When', render: s => dateTime(s.createdAt) },
          { label: 'Search', render: s => h('span', { class: 'small' }, [s.params.role || 'Roles from resume', [s.params.city, s.params.country].filter(Boolean).join(', ') || 'Any location',
            s.params.level, s.params.companies ? `Companies: ${s.params.companies}` : 'Well-known companies', s.params.resumeLabel].filter(Boolean).join(' · ')), wrap: true },
          { label: 'Result', render: s => (s.status === 'done' ? h('span', { class: 'cand-counts' }, h('span', { class: 'pill good' }, `${s.counts.high} high`), h('span', { class: 'pill warn' }, `${s.counts.medium} med`), h('span', { class: 'pill bad' }, `${s.counts.stretch} low`))
            : s.status === 'running' ? pill('open') : h('span', { class: 'small', style: 'color:var(--bad)' }, s.error || 'Failed')), wrap: true },
          { label: '', render: s => (s.status === 'done' ? h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); guard(() => showSearch(s)); } }, 'View results') : '') },
        ], d.searches, null, 'No AI job searches yet.'),
        results),

      section(`Job preparation plans (${d.preps.length})`,
        table([
          { label: 'Job', render: x => h('span', {}, h('b', {}, x.jobTitle), h('br'), h('span', { class: 'small muted' }, [x.company, x.location].filter(Boolean).join(' · '))), wrap: true },
          { label: 'Fit', render: x => scorePill(x.fit) }, { label: 'Skill score', render: x => scorePill(x.skillScore) },
          { label: 'Gaps', render: x => `${x.gaps} (+${x.gapPoints})` }, { label: 'Prepared', render: x => dateTime(x.createdAt) },
          { label: '', render: x => h('span', { class: 'tools' }, h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); guard(() => showPrep(x)); } }, 'View plan'),
            x.url ? h('a', { class: 'btn sm', href: x.url, target: '_blank', rel: 'noopener noreferrer', onclick: e => e.stopPropagation() }, 'Job ↗') : null) },
        ], d.preps, null, 'No preparation plans yet. They appear when the candidate presses "Insight" on a job.'),
        prepBox),

      h('div', { class: 'grid2', style: 'margin-top:14px' },
        h('div', { class: 'card' }, h('h2', {}, 'Activity'),
          d.activity.length ? h('ol', { class: 'cand-timeline' }, d.activity.map(a => h('li', {},
            h('span', { class: 'small muted', title: dateTime(a.at) }, ago(a.at)), h('b', {}, ACTION_LABEL[a.action] || a.action), a.detail ? h('span', { class: 'small' }, a.detail) : null)))
            : h('p', { class: 'muted small' }, 'No activity recorded yet. Sign-ins, uploads, AI actions and downloads are recorded from now on.')),
        h('div', { class: 'card' }, h('h2', {}, 'AI actions per day (30 days)'),
          d.usage.length ? h('div', { class: 'cand-bars' }, d.usage.map(u => h('div', { class: 'cand-bar', title: `${date(u.day)}: ${u.count}` },
            h('i', { style: `height:${Math.max(6, u.count / maxUse * 100)}%` }), h('span', {}, String(u.count)), h('small', {}, u.day.slice(5)))))
            : h('p', { class: 'muted small' }, 'No AI actions in the last 30 days.'))));
  }

  // ---------- AI tokens: daily allowance per customer, token packs, requests for more ----------
  const tok = n => { n = Number(n) || 0; return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n); };
  const priceText = (p, cur) => (p ? `${cur === 'INR' ? '₹' : cur + ' '}${Number(p).toLocaleString('en-IN')}` : 'Free / to quote');
  const kindText = (kind, tokens, days) => (kind === 'daily' ? `${tok(tokens)} a day for ${days} days` : `${tok(tokens)} extra tokens`);
  const LEVEL_PILL = { ok: 'good', warn: 'warn', out: 'bad' };

  async function tokens(el) {
    const d = await get('/admin/api/tokens');
    const write = can('tokens.write');
    const stat = (label, num, sub) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, num ?? 0), sub ? h('div', { class: 'sub' }, sub) : null);
    const reload = () => tokens(el);

    const daily = h('input', { type: 'number', min: 0, step: 1000, value: d.settings.dailyDefault, 'aria-label': 'Daily tokens per customer' });
    const warn = h('input', { type: 'number', min: 10, max: 99, value: d.settings.warnPct, 'aria-label': 'Warn at per cent' });
    const settingsCard = h('div', { class: 'card', style: 'margin-top:14px' },
      h('h2', {}, 'Daily allowance'),
      h('p', { class: 'muted small' }, `Every customer gets this many AI tokens a day (the day changes at midnight India time), unless you give them more. Customers see their tokens at the bottom of the website and are warned from the level below. Today is ${d.day}.`),
      h('div', { class: 'row2' },
        h('label', { class: 'field' }, 'Tokens per customer per day', daily, h('span', { class: 'hint' }, 'An ATS check uses about 8,000 tokens; an AI job search 20,000 to 30,000.')),
        h('label', { class: 'field' }, 'Warn customers at (% of the day used)', warn)),
      write ? h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => guard(async () => { await post('/admin/api/tokens/settings', { dailyDefault: daily.value, warnPct: warn.value }); toast('Saved'); reload(); }) }, 'Save')) : null);

    const decide = (k, action) => {
      if (action === 'reject') {
        const note = h('textarea', { maxlength: 500, placeholder: 'Reason (optional, for your records)' });
        dialog(`Reject request from ${k.customer.email}?`, h('div', {}, note), [{ label: 'Reject', kind: 'danger', run: async () => {
          const ok = await guard(async () => { await post(`/admin/api/tokens/claims/${k.id}`, { action: 'reject', note: note.value }); return true; });
          if (!ok) return true; toast('Rejected'); reload();
        } }]);
        return;
      }
      const f = h('div', {},
        h('p', { class: 'small' }, h('b', {}, k.customer.name || k.customer.email), ` asked for ${k.packName}: ${kindText(k.kind, k.tokens, k.days)}${k.price ? `, ${priceText(k.price, k.currency)}` : ''}.`, k.message ? h('span', { class: 'muted' }, ` "${k.message}"`) : null),
        field('Give', { name: 'kind', type: 'select', value: k.kind, options: [{ value: 'topup', label: 'Extra tokens (used after the daily allowance)' }, { value: 'daily', label: 'A bigger daily allowance for some days' }] }),
        h('div', { class: 'row2' }, field('Tokens', { name: 'tokens', type: 'number', value: k.tokens, min: 1000 }), field('Days (daily allowance only)', { name: 'days', type: 'number', value: k.days || 30, min: 1 })),
        field('Price agreed', { name: 'price', type: 'number', value: k.price, min: 0 }, `In ${k.currency}. Record what the customer paid or will pay.`),
        field('Note (optional)', { name: 'note', type: 'textarea', maxlength: 500 }));
      dialog('Approve token request', f, [{ label: 'Approve and give tokens', kind: 'primary', run: async () => {
        const ok = await guard(async () => { await post(`/admin/api/tokens/claims/${k.id}`, { action: 'approve', ...values(f) }); return true; });
        if (!ok) return true; toast('Approved: tokens given'); reload();
      } }]);
    };

    const packForm = existing => {
      const p = existing || { kind: 'topup', tokens: 200000, days: 30, price: 0, currency: 'INR', active: true, sort: 0 };
      const f = h('div', {},
        field('Name', { name: 'name', required: true, value: p.name || '', maxlength: 80, placeholder: 'e.g. Job hunt booster' }),
        field('Type', { name: 'kind', type: 'select', value: p.kind, options: [{ value: 'topup', label: 'Extra tokens (one time)' }, { value: 'daily', label: 'Bigger daily allowance for some days' }] }),
        h('div', { class: 'row2' }, field('Tokens', { name: 'tokens', type: 'number', value: p.tokens, min: 1000 }), field('Days (daily type only)', { name: 'days', type: 'number', value: p.days || 30, min: 1 })),
        h('div', { class: 'row2' }, field('Price', { name: 'price', type: 'number', value: p.price, min: 0 }), field('Currency', { name: 'currency', value: p.currency, maxlength: 8 })),
        field('Description (shown to customers)', { name: 'description', value: p.description || '', maxlength: 300 }),
        h('div', { class: 'row2' }, field('Order', { name: 'sort', type: 'number', value: p.sort || 0, min: 0 }),
          field('Offered to customers', { name: 'active', type: 'select', value: p.active ? 'yes' : 'no', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No (hidden)' }] })));
      dialog(existing ? 'Edit token pack' : 'New token pack', f, [{ label: 'Save', kind: 'primary', run: async () => {
        const v = values(f);
        const ok = await guard(async () => { await post('/admin/api/tokens/packs', { ...v, id: existing && existing.id, active: v.active === 'yes' }); return true; });
        if (!ok) return true; toast('Saved'); reload();
      } }]);
    };

    const grantForm = c => {
      const f = h('div', {},
        h('p', { class: 'small' }, `${c.name || c.email} has used ${tok(c.used)} of ${tok(c.daily)} today and has ${tok(c.bonus)} extra tokens.`),
        field('Give', { name: 'kind', type: 'select', options: [{ value: 'topup', label: 'Extra tokens' }, { value: 'daily', label: 'A bigger daily allowance' }] }),
        h('div', { class: 'row2' }, field('Tokens', { name: 'tokens', type: 'number', value: 100000, min: 1000 }), field('Days (daily allowance only)', { name: 'days', type: 'number', value: 30, min: 1 })));
      dialog(`Give tokens to ${c.email}`, f, [
        { label: 'Give tokens', kind: 'primary', run: async () => { const ok = await guard(async () => { await post(`/admin/api/tokens/customers/${c.id}`, values(f)); return true; }); if (!ok) return true; toast('Tokens given'); reload(); } },
        c.dailyUntil ? { label: 'Back to the default daily allowance', run: async () => { await guard(() => post(`/admin/api/tokens/customers/${c.id}`, { action: 'reset-daily' })); reload(); } } : null,
      ].filter(Boolean));
    };

    const pending = d.claims.filter(k => k.status === 'pending');
    el.replaceChildren(
      head('AI tokens', write ? h('button', { class: 'btn', onclick: () => packForm(null) }, '+ New token pack') : null),
      h('p', { class: 'muted' }, 'AI tokens used by website customers (Career toolkit, AI Job search, Insight). Set the daily allowance, offer token packs, and answer requests for more.'),
      h('div', { class: 'cards' },
        stat('Tokens used today', tok(d.totals.today.t), `${d.totals.today.c} AI calls by ${d.totals.today.n} customers`),
        stat('Tokens in 7 days', tok(d.totals.week.t), `${d.totals.week.c} AI calls`),
        stat('Requests waiting', d.totals.pending),
        stat('Daily allowance', tok(d.settings.dailyDefault), `warn at ${d.settings.warnPct}%`)),

      h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, `Requests for more tokens${pending.length ? ` (${pending.length} waiting)` : ''}`),
        table([
          { label: 'Customer', render: k => h('span', {}, h('b', {}, k.customer.name || k.customer.email), h('br'), h('span', { class: 'small muted' }, k.customer.email)) },
          { label: 'Asked for', render: k => h('span', {}, h('b', {}, k.packName), h('br'), h('span', { class: 'small' }, kindText(k.kind, k.tokens, k.days))) },
          { label: 'Price', render: k => priceText(k.price, k.currency) },
          { label: 'Message', render: k => h('span', { class: 'small' }, k.message || '—'), wrap: true },
          { label: 'When', render: k => dateTime(k.createdAt) },
          { label: 'Status', render: k => h('span', {}, pill(k.status), k.decidedBy ? h('div', { class: 'small muted' }, `${k.decidedBy}${k.adminNote ? ': ' + k.adminNote : ''}`) : null) },
          { label: '', render: k => (write && k.status === 'pending' ? h('span', { class: 'tools' },
            h('button', { class: 'btn sm primary', onclick: e => { e.stopPropagation(); decide(k, 'approve'); } }, 'Approve'),
            h('button', { class: 'btn sm danger', onclick: e => { e.stopPropagation(); decide(k, 'reject'); } }, 'Reject')) : '') },
        ], d.claims, null, 'No requests yet. Customers ask for more tokens from the bottom of the website.')),

      h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, 'Token packs offered to customers'),
        table([
          { label: 'Pack', render: p => h('span', {}, h('b', {}, p.name), p.description ? h('div', { class: 'small muted' }, p.description) : null), wrap: true },
          { label: 'Gives', render: p => kindText(p.kind, p.tokens, p.days) },
          { label: 'Price', render: p => priceText(p.price, p.currency) },
          { label: 'Shown', render: p => pill(p.active ? 'on' : 'off') },
          { label: '', render: p => (write ? h('span', { class: 'tools' },
            h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); packForm(p); } }, 'Edit'),
            h('button', { class: 'btn sm danger', onclick: e => { e.stopPropagation(); if (confirm(`Delete the pack "${p.name}"?`)) guard(async () => { await del(`/admin/api/tokens/packs/${p.id}`); reload(); }); } }, 'Delete')) : '') },
        ], d.packs, null, 'No packs yet. Add one (for example 2 lakh extra tokens for ₹99). Customers can always send a custom request too.')),

      settingsCard,

      h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, 'Customers'),
        table([
          { label: 'Customer', render: c => h('span', {}, h('b', {}, c.name || c.email), h('br'), h('span', { class: 'small muted' }, c.email)) },
          { label: 'Today', render: c => h('span', {}, `${tok(c.used)} / ${tok(c.daily)}`, h('div', { class: 'tok-bar' }, h('i', { class: c.level, style: `width:${c.pct}%` }))) },
          { label: 'Extra tokens', render: c => tok(c.bonus) },
          { label: 'Left today', render: c => h('span', { class: 'tok-left ' + c.level }, tok(c.left), c.level !== 'ok' ? h('span', { class: 'small' }, c.level === 'out' ? ' · used up' : ' · running low') : null) },
          { label: 'Daily allowance', render: c => (c.dailyUntil ? h('span', { class: 'small' }, `${tok(c.daily)} until ${date(c.dailyUntil)}`) : h('span', { class: 'small muted' }, 'default')) },
          { label: '7 days', render: c => tok(c.week) },
          { label: '', render: c => (write ? h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); grantForm(c); } }, 'Give tokens') : '') },
        ], d.customers, null, 'No AI use yet.')));
  }

  // ---------- Pricing: plans master, active pricing (the website), payment settings, plan orders ----------
  const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const ORDER_PILL = { created: '', pending: 'warn', paid: 'good', failed: 'bad', cancelled: '', refunded: 'warn' };
  const LIMIT_LABELS = { dailyTokens: 'AI tokens a day', jobSearches: 'AI job searches', preps: 'Insight plans', roleResumes: 'Role-based resumes', liveSessions: 'Live interview sessions' };

  async function pricingPage(el) {
    const d = await get('/admin/api/pricing');
    const write = can('pricing.write');
    const reload = () => pricingPage(el);
    const stat = (label, num, sub) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, num ?? 0), sub ? h('div', { class: 'sub' }, sub) : null);
    const act = (p, action, msg) => guard(async () => { await post(`/admin/api/pricing/plans/${p.id}/action`, { action }); if (msg) toast(msg); reload(); });

    // --- plan form (master) ---
    const planForm = existing => {
      const p = existing || { name: '', code: '', tagline: '', description: '', price: 0, mrp: 0, durationDays: 30, billing: 'one_time', features: [], limits: { dailyTokens: 100000 }, badge: '', cta: '', sort: 100 };
      const f = h('div', {},
        h('div', { class: 'row2' }, field('Plan name', { name: 'name', required: true, value: p.name, maxlength: 60, placeholder: 'e.g. Interview Pass' }),
          field('Code (stays the same; used in orders)', { name: 'code', value: p.code, maxlength: 40, placeholder: 'interview-30' })),
        field('Tagline (under the name)', { name: 'tagline', value: p.tagline, maxlength: 120 }),
        h('div', { class: 'row2' }, field('Price (₹, including GST unless set otherwise)', { name: 'price', type: 'number', value: p.price, min: 0 }),
          field('Strike-through price (₹, 0 = none)', { name: 'mrp', type: 'number', value: p.mrp, min: 0 })),
        h('div', { class: 'row2' }, field('Length (days)', { name: 'durationDays', type: 'number', value: p.durationDays, min: 1 }),
          field('Billing', { name: 'billing', type: 'select', value: p.billing, options: [{ value: 'one_time', label: 'One-time pass (does not renew)' }, { value: 'subscription', label: 'Subscription (renews, needs an online gateway)' }] })),
        field('What is included (one line each)', { name: 'features', type: 'textarea', value: (p.features || []).join('\n'), maxlength: 2000 }),
        h('h3', { style: 'margin:10px 0 4px' }, 'Limits'),
        h('p', { class: 'small muted' }, 'AI tokens a day is enforced now (the token meter). The other limits are shown and kept for later enforcement.'),
        h('div', { class: 'row2' }, ...Object.keys(LIMIT_LABELS).map(k => field(LIMIT_LABELS[k], { name: 'limit_' + k, type: 'number', value: p.limits && p.limits[k] != null ? p.limits[k] : '', min: 0 }))),
        h('div', { class: 'row2' }, field('Badge (e.g. Most popular)', { name: 'badge', value: p.badge, maxlength: 30 }), field('Button text', { name: 'cta', value: p.cta, maxlength: 40, placeholder: 'Get this plan' })),
        field('Order on the page (smaller first)', { name: 'sort', type: 'number', value: p.sort, min: 0 }));
      dialog(existing ? `Edit plan: ${p.name}` : 'New plan', f, [{ label: 'Save plan', kind: 'primary', run: async () => {
        const v = values(f);
        const limits = {}; Object.keys(LIMIT_LABELS).forEach(k => { limits[k] = v['limit_' + k]; });
        const ok = await guard(async () => { await post('/admin/api/pricing/plans', { ...v, id: existing && existing.id, limits, features: v.features }); return true; });
        if (!ok) return true; toast(existing ? 'Plan saved' : 'Plan added (not shown on the website until you activate it)'); reload();
      } }]).el.classList.add('wide');
    };

    // --- active pricing: what the website shows, in order ---
    const active = d.plans.filter(p => p.active && !p.archived);
    const preview = h('div', { class: 'price-preview' }, active.length ? active.map(p => h('div', { class: 'price-card' + (p.featured ? ' featured' : '') },
      p.badge ? h('span', { class: 'price-badge' }, p.badge) : null,
      h('b', {}, p.name), h('div', { class: 'small muted' }, p.tagline || ''),
      h('div', { class: 'price-amount' }, p.price ? inr(p.price) : 'Free', p.mrp ? h('s', { class: 'muted small' }, ' ' + inr(p.mrp)) : null,
        h('span', { class: 'small muted' }, p.price ? ` / ${p.durationDays} days` : '')),
      h('ul', { class: 'small' }, (p.features || []).slice(0, 4).map(x => h('li', {}, x))))) : h('p', { class: 'muted' }, 'No active plans: the website shows a "plans coming soon" message.'));

    // --- payment settings ---
    const c = d.config;
    const pay = h('div', {},
      h('div', { class: 'row2' },
        field('Payment gateway', { name: 'provider', type: 'select', value: c.provider, options: d.gateways.map(g => ({ value: g.id, label: g.name + (g.online && !c.adapterReady.includes(g.id) ? ' (not connected yet)' : '') })) }),
        field('Mode', { name: 'mode', type: 'select', value: c.mode, options: [{ value: 'test', label: 'Test (sandbox)' }, { value: 'live', label: 'Live (real money)' }] })),
      h('div', { class: 'field' }, 'Payment methods offered', h('div', { class: 'pay-methods' }, d.methods.map(m => h('label', { class: 'check' },
        Object.assign(h('input', { type: 'checkbox', name: 'm_' + m }), { checked: !!c.methods[m] }), ' ' + c.methodNames[m])))),
      h('div', { class: 'row2' },
        field('GST rate (%)', { name: 'gstRate', type: 'select', value: String(c.gstRate), options: [0, 5, 12, 18, 28].map(r => ({ value: String(r), label: r + '%' })) }),
        field('Prices on the website', { name: 'pricesIncludeGst', type: 'select', value: c.pricesIncludeGst ? 'yes' : 'no', options: [{ value: 'yes', label: 'Include GST (recommended for consumers)' }, { value: 'no', label: 'GST added at checkout' }] })),
      h('div', { class: 'row2' }, field('GSTIN (optional)', { name: 'gstin', value: c.gstin, maxlength: 15, placeholder: '09ABCDE1234F1Z5' }), field('Order number prefix', { name: 'invoicePrefix', value: c.invoicePrefix, maxlength: 8 })),
      h('h3', { style: 'margin:12px 0 4px' }, 'UPI and bank transfer (used until a gateway is connected)'),
      h('div', { class: 'row2' }, field('UPI ID', { name: 'upiId', value: c.manual.upiId, maxlength: 60, placeholder: 'yourname@bank' }), field('Payee name', { name: 'payeeName', value: c.manual.payeeName, maxlength: 80 })),
      h('div', { class: 'row2' }, field('Bank name', { name: 'bankName', value: c.manual.bankName, maxlength: 80 }), field('Account name', { name: 'accountName', value: c.manual.accountName, maxlength: 80 })),
      h('div', { class: 'row2' }, field('Account number', { name: 'accountNumber', value: c.manual.accountNumber, maxlength: 30 }), field('IFSC', { name: 'ifsc', value: c.manual.ifsc, maxlength: 11 })),
      field('Instructions shown to the customer', { name: 'instructions', type: 'textarea', value: c.manual.instructions, maxlength: 500 }),
      h('h3', { style: 'margin:12px 0 4px' }, 'Gateway keys (for later)'),
      h('p', { class: 'small muted' }, c.connected ? 'Online payments are connected.' : 'Online payments are not connected yet: save the keys now; the gateway goes live when its connector is added.'),
      h('div', { class: 'row2' }, field('Key ID / App ID (public)', { name: 'keyId', value: c.keyId, maxlength: 120 }),
        field(`Key secret ${c.secrets.keySecret ? '(saved ✓, leave empty to keep)' : ''}`, { name: 'keySecret', type: 'password', maxlength: 300 })),
      field(`Webhook secret ${c.secrets.webhookSecret ? '(saved ✓, leave empty to keep)' : ''}`, { name: 'webhookSecret', type: 'password', maxlength: 300 }, 'Gateway webhook address: https://<your API address>/api/payments/webhook/' + c.provider),
      write ? h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => guard(async () => {
        const v = values(pay);
        const methods = {}; d.methods.forEach(m => { methods[m] = v['m_' + m]; });
        await post('/admin/api/pricing/config', { provider: v.provider, mode: v.mode, methods, gstRate: Number(v.gstRate), pricesIncludeGst: v.pricesIncludeGst === 'yes', gstin: v.gstin, invoicePrefix: v.invoicePrefix,
          keyId: v.keyId, keySecret: v.keySecret, webhookSecret: v.webhookSecret,
          manual: { upiId: v.upiId, payeeName: v.payeeName, bankName: v.bankName, accountName: v.accountName, accountNumber: v.accountNumber, ifsc: v.ifsc, instructions: v.instructions } });
        toast('Payment settings saved'); reload();
      }) }, 'Save payment settings')) : null);

    // --- orders ---
    const decide = (o, action) => {
      if (action === 'mark-paid') {
        const f = h('div', {}, h('p', { class: 'small' }, `${o.customer.name || o.customer.email} · ${o.planName} · ${inr(o.amount)} · ${o.number}`),
          o.reference ? h('p', { class: 'small' }, h('b', {}, 'Customer reference: '), `${(o.paymentMode || '').toUpperCase()} ${o.reference}`) : h('p', { class: 'small muted' }, 'The customer has not entered a reference yet.'),
          h('p', { class: 'small' }, 'Check the money arrived in your bank or UPI app before confirming. Confirming starts the plan now.'),
          field('Payment method', { name: 'method', type: 'select', value: o.paymentMode || 'upi', options: d.methods.map(m => ({ value: m, label: c.methodNames[m] })) }),
          field('Reference (UTR), if different', { name: 'reference', maxlength: 80 }), field('Note (optional)', { name: 'note', maxlength: 300 }));
        dialog('Confirm payment and start the plan', f, [{ label: 'Payment received: start plan', kind: 'primary', run: async () => {
          const ok = await guard(async () => { await post(`/admin/api/pricing/orders/${o.id}`, { action, ...values(f) }); return true; }); if (!ok) return true; toast('Plan started'); reload();
        } }]);
        return;
      }
      const note = prompt(action === 'refund' ? 'Refund note (e.g. refunded by UPI on ...)' : 'Reason (optional)') ;
      if (note === null) return;
      guard(async () => { await post(`/admin/api/pricing/orders/${o.id}`, { action, note }); toast('Done'); reload(); });
    };

    el.replaceChildren(
      head('Pricing', write ? h('button', { class: 'btn primary', onclick: () => planForm(null) }, '+ New plan') : null),
      h('p', { class: 'muted' }, 'All prices are in INR. The plans master holds every plan; active plans are shown on the website\'s pricing page in this order. Payments are by UPI or bank transfer, confirmed by you, until an online gateway is connected.'),
      h('div', { class: 'cards' }, stat('Plans on the website', d.stats.activePlans), stat('Payments to confirm', d.stats.pending),
        stat('Paid this month', inr(d.stats.paidMonth.t / 100), `${d.stats.paidMonth.n} orders`), stat('Customers on a plan', d.stats.subscribers)),

      h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, 'Active pricing (what the website shows)'), preview,
        h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Show or hide plans, change the order and the featured plan in the plans master below. Changes appear on the website at once.')),

      h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, `Payments to confirm and orders (${d.orders.length})`),
        table([
          { label: 'Order', render: o => h('span', {}, h('b', {}, o.number), h('br'), h('span', { class: 'small muted' }, dateTime(o.createdAt))) },
          { label: 'Customer', render: o => h('span', {}, o.customer.name || o.customer.email, h('br'), h('span', { class: 'small muted' }, o.customer.email)) },
          { label: 'Plan', render: o => o.planName },
          { label: 'Amount', render: o => h('span', {}, h('b', {}, inr(o.amount)), o.gst ? h('div', { class: 'small muted' }, `incl. GST ${inr(o.gst)}`) : null) },
          { label: 'Paid by', render: o => (o.reference ? h('span', { class: 'small' }, `${(o.paymentMode || '').toUpperCase()} · ${o.reference}`) : h('span', { class: 'small muted' }, '—')) },
          { label: 'Status', render: o => h('span', {}, h('span', { class: 'pill ' + (ORDER_PILL[o.status] || '') }, o.status === 'pending' ? 'to confirm' : o.status),
            o.endsAt && o.status === 'paid' ? h('div', { class: 'small muted' }, 'until ' + date(o.endsAt)) : null, o.note ? h('div', { class: 'small muted' }, o.note) : null) },
          { label: '', render: o => (write ? h('span', { class: 'tools' },
            ['created', 'pending', 'failed'].includes(o.status) ? h('button', { class: 'btn sm primary', onclick: e => { e.stopPropagation(); decide(o, 'mark-paid'); } }, 'Confirm payment') : null,
            ['created', 'pending'].includes(o.status) ? h('button', { class: 'btn sm danger', onclick: e => { e.stopPropagation(); decide(o, 'reject'); } }, 'Not received') : null,
            o.status === 'paid' ? h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); decide(o, 'refund'); } }, 'Mark refunded') : null) : '') },
        ], d.orders, null, 'No orders yet. They appear when a customer buys a plan on the pricing page.')),

      h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, 'Plans master'),
        table([
          { label: '', render: p => (write && !p.archived ? h('span', { class: 'tools' }, h('button', { class: 'btn sm', title: 'Move up', onclick: e => { e.stopPropagation(); act(p, 'up'); } }, '↑'),
            h('button', { class: 'btn sm', title: 'Move down', onclick: e => { e.stopPropagation(); act(p, 'down'); } }, '↓')) : '') },
          { label: 'Plan', render: p => h('span', {}, h('b', {}, p.name), p.featured ? h('span', { class: 'pill good', style: 'margin-left:6px' }, '★ featured') : null, h('br'), h('span', { class: 'small muted' }, `${p.code} · ${p.tagline || ''}`)), wrap: true },
          { label: 'Price', render: p => h('span', {}, h('b', {}, p.price ? inr(p.price) : 'Free'), p.mrp ? h('s', { class: 'small muted' }, ' ' + inr(p.mrp)) : null) },
          { label: 'Length', render: p => `${p.durationDays} days${p.billing === 'subscription' ? ' · renews' : ''}` },
          { label: 'AI tokens a day', render: p => (p.limits.dailyTokens ? Number(p.limits.dailyTokens).toLocaleString('en-IN') : 'default') },
          { label: 'On website', render: p => (p.archived ? pill('archived') : p.active ? pill('on') : pill('off')) },
          { label: '', render: p => (write ? h('span', { class: 'tools' },
            h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); planForm(p); } }, 'Edit'),
            !p.archived ? h('button', { class: 'btn sm' + (p.active ? '' : ' primary'), onclick: e => { e.stopPropagation(); act(p, p.active ? 'deactivate' : 'activate', p.active ? 'Hidden from the website' : 'Shown on the website'); } }, p.active ? 'Hide' : 'Show on website') : null,
            !p.archived && p.active && !p.featured ? h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); act(p, 'feature', 'Featured'); } }, '★ Feature') : null,
            p.featured ? h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); act(p, 'unfeature'); } }, 'Unfeature') : null,
            p.archived ? h('button', { class: 'btn sm', onclick: e => { e.stopPropagation(); act(p, 'restore', 'Restored'); } }, 'Restore')
              : h('button', { class: 'btn sm danger', onclick: e => { e.stopPropagation(); if (confirm(`Archive "${p.name}"? It is hidden from the website; past orders keep it.`)) act(p, 'archive', 'Archived'); } }, 'Archive')) : '') },
        ], d.plans, null, 'No plans yet.')),

      h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, 'Payment settings'), pay),

      h('div', { class: 'card', style: 'margin-top:14px' }, h('h2', {}, 'Price history'),
        table([
          { label: 'When', render: x => dateTime(x.at) }, { label: 'Plan', render: x => x.planName },
          { label: 'Price', render: x => `${inr(x.oldPrice)} → ${inr(x.newPrice)}` },
          { label: 'Strike-through', render: x => (x.oldMrp || x.newMrp ? `${inr(x.oldMrp)} → ${inr(x.newMrp)}` : '—') }, { label: 'By', render: x => x.by },
        ], d.history, null, 'No price changes yet.')));
  }

  // ---------- AI Job search: the Master Prompt (candidates choose the companies, country and role themselves) ----------
  async function jobs(el) {
    const d = await get('/admin/api/jobs');
    const write = can('jobs.write');
    const stat = (label, num, sub) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, num ?? 0), sub ? h('div', { class: 'sub' }, sub) : null);
    el.replaceChildren(
      head('Jobs'),
      h('p', { class: 'muted' }, 'Candidates run AI Job search in Career toolkit: they pick a resume (or all of them) and type the country, city, role and companies they want. ' +
        'The server reads those companies\' live openings from their own career sites, and the AI scores them with the Master Prompt below into high, medium and low-probability jobs.'),
      h('div', { class: 'cards' }, stat('Searches (7 days)', d.stats.searches), stat('Candidates searching (7 days)', d.stats.candidates), stat('Failed searches (7 days)', d.stats.failed),
        stat('Live jobs cached', d.stats.jobs, `from ${d.stats.companies} career sites`)),
      promptCard(d, write, () => jobs(el)),
      h('details', { class: 'card', style: 'margin-top:18px' }, h('summary', {}, `Companies searched when a candidate leaves "Companies" empty (${d.builtInCompanies.length})`),
        h('p', { class: 'muted small' }, d.builtInCompanies.join(', '))));
  }

  function promptCard(d, write, done) {
    const box = h('textarea', { name: 'prompt', maxlength: 8000, readonly: !write }, d.prompt.prompt);
    box.style.minHeight = '320px';
    return h('div', { class: 'card', style: 'margin-top:18px' },
      h('h2', {}, 'Master Prompt'),
      h('p', { class: 'muted small' }, 'Runs on every AI Job search: first the AI analyses the candidate\'s resume(s), then it scores the live jobs found for their search. ' +
        (d.prompt.isDefault ? 'Using the default prompt.' : `Last changed ${dateTime(d.prompt.updatedAt)} by ${d.prompt.updatedBy}.`)),
      box,
      h('details', {}, h('summary', { class: 'small' }, 'Rules always added after your prompt (keep the AI from inventing jobs, and the answer readable)'), h('pre', { class: 'mono small', style: 'white-space:pre-wrap' }, d.outputRules)),
      write ? h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => guard(async () => { await post('/admin/api/jobs/prompt', { prompt: box.value }); toast('Master prompt saved'); done(); }) }, 'Save prompt'),
        h('button', { class: 'btn', onclick: () => { if (confirm('Go back to the default prompt?')) guard(async () => { await post('/admin/api/jobs/prompt', { reset: true }); toast('Default prompt restored'); done(); }); } }, 'Reset to default')) : null);
  }

  // ---------- ShortlistPrep.AI conversations (saved by the app when the class ends) ----------
  const duration = sec => { const m = Math.round((sec || 0) / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const clock = s => new Date(s).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  async function conversations(el, filters = { q: '', from: '', to: '' }) {
    const { q, from, to } = filters;
    const { conversations: rows } = await get(`/admin/api/conversations?q=${encodeURIComponent(q)}&from=${from}&to=${to}`);
    const redo = change => conversations(el, { ...filters, ...change });
    const day = (label, key) => { const i = h('input', { type: 'date', 'aria-label': label, title: label, onchange: e => redo({ [key]: e.target.value }) }); i.value = filters[key]; return i; };
    el.replaceChildren(
      head('Conversations', searchBox(v => redo({ q: v }), 'Search questions, answers, customer', q), day('From', 'from'), day('To', 'to'),
        from || to ? h('button', { class: 'btn sm', onclick: () => redo({ from: '', to: '' }) }, 'All dates') : null),
      h('p', { class: 'muted' }, 'Every ShortlistPrep.AI session is saved here when the teacher presses End: what was heard, and each question with its answer.'),
      table([
        { label: 'Date and time', render: r => dateTime(r.started_at) }, { label: 'Length', render: r => duration(r.duration_sec) },
        { label: 'Customer', render: r => r.customer_name || r.customer_email }, { label: 'Computer', render: r => r.device_name || '—' },
        { label: 'Questions', render: r => r.question_count },
        { label: 'First question', wrap: true, render: r => (r.first_question ? (r.first_question.length > 80 ? r.first_question.slice(0, 80) + '…' : r.first_question) : '—') },
      ], rows, r => conversationDetail(r.id, () => conversations(el, filters)), q || from || to ? 'No conversations match.' : 'No conversations yet. They appear here when a ShortlistPrep.AI session ends.'));
  }

  async function conversationDetail(id, done) {
    const { conversation: v, items } = await get('/admin/api/conversations/' + id);
    const body = h('div', {},
      h('dl', { class: 'kv' },
        h('dt', {}, 'Started'), h('dd', {}, dateTime(v.started_at)), h('dt', {}, 'Ended'), h('dd', {}, `${dateTime(v.ended_at)} (${duration(v.duration_sec)})`),
        h('dt', {}, 'Customer'), h('dd', {}, v.customer_name ? `${v.customer_name} <${v.customer_email}>` : v.customer_email),
        h('dt', {}, 'Licence'), h('dd', { class: 'mono' }, v.licence_key), h('dt', {}, 'Computer'), h('dd', {}, v.device_name || '—'),
        h('dt', {}, 'Subject'), h('dd', {}, v.subject || '—')),
      h('h3', {}, `Questions and answers (${items.length})`),
      items.length ? items.map(it => h('div', { class: 'qa' },
        h('div', { class: 'meta' }, `${it.position}. ${clock(it.asked_at)}${it.source ? ' · ' + it.source : ''}${it.vote === 1 ? ' · 👍' : it.vote === -1 ? ' · 👎' : ''}`),
        h('div', { class: 'q' }, it.question),
        it.status === 'done' ? h('div', { class: 'a' }, it.answer)
          : h('div', { class: 'a muted' }, it.status === 'error' ? 'No answer: ' + (it.error || 'the AI could not answer') : 'Not answered before the class ended'))) : h('p', { class: 'muted' }, 'No questions were asked.'),
      h('details', { open: !items.length }, h('summary', {}, `Everything that was heard (${v.transcript.length} phrases)`),
        v.transcript.length ? h('div', { class: 'transcript' }, v.transcript.map(p => h('div', {}, h('span', { class: 't' }, clock(p.at)), p.text)))
          : h('p', { class: 'muted' }, 'Nothing was heard (the microphone was off).')));
    const buttons = [{ label: 'Download as text', run: () => { downloadConversation(v, items); return true; }, closes: false }];
    if (can('conversations.delete')) buttons.push({ label: 'Delete', kind: 'danger', run: async () => {
      if (!confirm('Delete this conversation? This cannot be undone.')) return true;
      const ok = await guard(async () => { await del('/admin/api/conversations/' + v.id); return true; });
      if (!ok) return true;
      toast('Conversation deleted'); done();
    } });
    buttons.push({ label: 'Close', run: () => {} });
    dialog(`ShortlistPrep.AI · ${dateTime(v.started_at)}`, body, buttons).el.classList.add('wide');
  }

  function downloadConversation(v, items) {
    const lines = [`ShortlistPrep.AI conversation`, `Started: ${dateTime(v.started_at)}`, `Ended: ${dateTime(v.ended_at)} (${duration(v.duration_sec)})`,
      `Customer: ${v.customer_email}`, `Computer: ${v.device_name || '-'}`, v.subject ? `Subject: ${v.subject}` : '', '', 'QUESTIONS AND ANSWERS', ''];
    for (const it of items) lines.push(`${it.position}. [${clock(it.asked_at)}] ${it.question}`, it.status === 'done' ? it.answer : '(no answer)', '');
    lines.push('', 'EVERYTHING THAT WAS HEARD', '', ...v.transcript.map(p => `[${clock(p.at)}] ${p.text}`));
    const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/plain' })), download: `shortlistprep-ai-${v.started_at.slice(0, 16).replace(/[T:]/g, '-')}.txt` });
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- audit ----------
  async function audit(el, query = '') {
    const { entries } = await get('/admin/api/audit?q=' + encodeURIComponent(query));
    el.replaceChildren(head('Audit log', searchBox(v => audit(el, v), 'Search action, person or target', query)),
      table([{ label: 'When', render: r => dateTime(r.at) }, { label: 'Who', render: r => r.admin_email }, { label: 'Action', render: r => r.action }, { label: 'Target', render: r => r.target }, { label: 'Detail', wrap: true, render: r => r.detail }],
        entries, null, 'Nothing recorded yet.'));
  }

  // ---------- team + account ----------
  async function team(el) {
    const { admins } = await get('/admin/api/team');
    el.replaceChildren(head('Team', h('button', { class: 'btn primary', onclick: () => teamForm(() => team(el)) }, '+ Add person')),
      table([
        { label: 'Email', render: r => r.email }, { label: 'Name', render: r => r.name || '—' }, { label: 'Role', render: r => pill(r.role) },
        { label: 'Status', render: r => (r.disabled ? pill('revoked') : pill('active')) }, { label: 'Last sign-in', render: r => dateTime(r.last_login) },
        { label: '', render: r => (r.email === me.email ? h('span', { class: 'muted' }, 'you') : h('span', { class: 'tools' },
          h('button', { class: 'btn sm', onclick: () => guard(async () => { await patch(`/admin/api/team/${r.id}`, { disabled: !r.disabled }); toast(r.disabled ? 'Access restored' : 'Access removed'); team(el); }) }, r.disabled ? 'Enable' : 'Disable'),
          h('button', { class: 'btn sm', onclick: () => passwordReset(r) }, 'New password'))) },
      ], admins, null, 'No team members.'),
      h('p', { class: 'muted small' }, 'Owner: everything. Admin: everything except the team. Support: read everything, answer messages, extend licences and reset computers.'));
  }
  function teamForm(done) {
    const f = h('div', {}, field('Email', { name: 'email', type: 'email', required: true }), field('Name', { name: 'name' }),
      field('Role', { name: 'role', type: 'select', options: [{ value: 'support', label: 'Support' }, { value: 'admin', label: 'Admin' }, { value: 'owner', label: 'Owner' }] }),
      field('Starting password', { name: 'password', type: 'password' }, 'At least 10 characters. Ask them to change it after signing in.'));
    dialog('Add person', f, [{ label: 'Add', kind: 'primary', run: async () => { const ok = await guard(async () => { await post('/admin/api/team', values(f)); return true; }); if (!ok) return true; toast('Added'); done(); } }]);
  }
  function passwordReset(r) {
    const f = field('New password', { name: 'password', type: 'password' }, 'At least 10 characters. They are signed out everywhere.');
    dialog(`New password for ${r.email}`, f, [{ label: 'Set password', kind: 'primary', run: async () => { const ok = await guard(async () => { await patch(`/admin/api/team/${r.id}`, { password: values(f).password }); return true; }); if (!ok) return true; toast('Password changed'); } }]);
  }

  function account(el) {
    const f = h('div', { class: 'card', style: 'max-width:420px' }, h('h2', {}, 'Change my password'),
      field('Current password', { name: 'current', type: 'password' }), field('New password', { name: 'next', type: 'password' }, 'At least 10 characters.'),
      h('button', { class: 'btn primary', onclick: () => guard(async () => { await post('/admin/api/password', values(f)); toast('Password changed'); f.querySelectorAll('input').forEach(i => { i.value = ''; }); }) }, 'Change password'));
    el.replaceChildren(head('My account'), h('dl', { class: 'kv' }, h('dt', {}, 'Email'), h('dd', {}, me.email), h('dt', {}, 'Role'), h('dd', {}, me.role)), f,
      h('div', { class: 'card', style: 'max-width:620px;margin-top:14px' }, h('h2', {}, 'Licence key for the app'), h('p', { class: 'muted' }, 'The app verifies the signed answers from /api/licence/activate with this public key. Embed it in the app.'),
        h('pre', { class: 'mono small', id: 'pubkey', style: 'white-space:pre-wrap;word-break:break-all' }, 'Loading…')));
    guard(async () => { document.getElementById('pubkey').textContent = (await get('/api/public-key')).publicKey; });
  }

  // ---------- Badminton: tournaments, teams, fixtures, courts and live scoring (private) ----------
  let bdId = null;          // the tournament that is open
  let bdTab = 'score';
  const BD_STATUS = { scheduled: 'Waiting', live: 'Live', finished: 'Finished', walkover: 'Walkover', cancelled: 'Cancelled' };
  const BD_PILL = { scheduled: '', live: 'bad', finished: 'good', walkover: 'warn', cancelled: '' };
  const bdNum = (v, d) => (v === '' || v === undefined || v === null ? d : Number(v));

  async function badminton(el) {
    if (bdId) {
      try { return bdShow(el, await get('/admin/api/badminton/' + bdId)); } catch (err) { bdId = null; toast(err.message, true); }
    }
    const { tournaments: rows } = await get('/admin/api/badminton');
    const write = can('badminton.write');
    el.replaceChildren(
      head('Badminton', write ? h('button', { class: 'btn primary', onclick: () => bdSettings(null, () => badminton(el), el) }, '+ New tournament') : null),
      h('p', { class: 'muted' }, 'Private: not shown anywhere on the website. Make a tournament, decide the teams, make the fixtures, score the matches, and share the live link with your team. They open the link (or type the keyword) to see the latest scores.'),
      table([
        { label: 'Tournament', render: r => h('span', {}, h('b', {}, r.name), h('div', { class: 'muted small' }, r.venue || '')), wrap: true },
        { label: 'Keyword', render: r => h('span', { class: 'mono' }, r.keyword) },
        { label: 'Status', render: r => h('span', { class: 'pill ' + (r.status === 'live' ? 'bad' : r.status === 'finished' ? 'good' : '') }, r.status === 'live' ? 'Live' : r.status === 'finished' ? 'Finished' : 'Not started') },
        { label: 'Teams', render: r => r.teams }, { label: 'Courts', render: r => r.courts },
        { label: 'Matches played', render: r => `${r.played} of ${r.matches}` },
        { label: 'Live page', render: r => (r.shared ? 'On' : 'Off') },
      ], rows, r => { bdId = r.id; bdTab = r.matches ? 'score' : r.teams ? 'fixtures' : 'teams'; badminton(el); }, 'No tournaments yet. Start one with "+ New tournament".'));
  }

  function bdShow(el, d) {
    const t = d.tournament, write = can('badminton.write'), score = can('badminton.score');
    const redo = fresh => (fresh ? bdShow(el, fresh) : badminton(el));
    const act = async (fn, okMessage) => { const r = await guard(fn); if (r) { if (okMessage) toast(okMessage); bdShow(el, r); } return r; };
    const teamName = id => (d.teams.find(x => x.id === id) || {}).name || 'To be decided';
    const tabs = [['score', 'Live scoring'], ['teams', 'Teams'], ['fixtures', 'Fixtures'], ['table', 'Table'], ['share', 'Share and settings']];
    const link = h('input', { value: d.shareUrl, readonly: true, 'aria-label': 'Live page link', style: 'width:100%' });
    const body = el2 => el2;

    const panel = {
      score: () => bdScore(d, act, score, teamName),
      teams: () => bdTeams(d, act, write, el),
      fixtures: () => bdFixtures(d, act, write, teamName),
      table: () => bdTable(d),
      share: () => h('div', { class: 'card' },
        h('h2', {}, 'Share with your team'),
        h('p', { class: 'muted' }, 'They need no sign-in. They open this link, or the live page and type the keyword. The page refreshes by itself every few seconds.'),
        h('label', { class: 'field' }, 'Live page link', link),
        h('p', {}, h('b', {}, 'Keyword: '), h('span', { class: 'mono' }, t.keyword), '  ', h('span', { class: 'pill ' + (t.shared ? 'good' : '') }, t.shared ? 'Live page is on' : 'Live page is off')),
        h('div', { class: 'tools' },
          h('button', { class: 'btn', onclick: async () => { link.select(); try { await navigator.clipboard.writeText(d.shareUrl); toast('Link copied'); } catch (_) { toast('Press Ctrl+C to copy the link'); } } }, 'Copy link'),
          h('a', { class: 'btn', href: d.shareUrl, target: '_blank', rel: 'noopener' }, 'Open live page'),
          write ? h('button', { class: 'btn', onclick: () => bdSettings(d, () => badminton(el), el) }, 'Settings and keyword') : null,
          write ? h('button', { class: 'btn', onclick: () => bdAnnounce(t, act) }, 'Announcement') : null,
          write ? h('button', { class: 'btn danger', onclick: () => { if (confirm(`Delete "${t.name}" with all its teams, matches and scores? This cannot be undone.`)) guard(async () => { await del('/admin/api/badminton/' + t.id); bdId = null; toast('Tournament deleted'); badminton(el); }); } }, 'Delete tournament') : null)),
    };

    el.replaceChildren(...[
      head(t.name, h('button', { class: 'btn', onclick: () => { bdId = null; badminton(el); } }, '← All tournaments'),
        h('span', { class: 'pill ' + (t.status === 'live' ? 'bad' : t.status === 'finished' ? 'good' : '') }, t.status === 'live' ? 'Live' : t.status === 'finished' ? 'Finished' : 'Not started')),
      d.champion ? h('p', { class: 'bd-champ' }, 'Champions: ' + d.champion) : null,
      h('div', { class: 'bd-tabs', role: 'tablist' }, tabs.map(([id, label]) => h('button', { class: 'btn' + (bdTab === id ? ' primary' : ''), role: 'tab', 'aria-selected': bdTab === id ? 'true' : 'false', onclick: () => { bdTab = id; bdShow(el, d); } }, label))),
      body(panel[bdTab]())].filter(Boolean));   // (replaceChildren would write a null as the word "null")
  }

  /** One match on the scoring screen: the score, the +1 / -1 buttons, and Finish / Reset. */
  function bdMatchCard(m, d, act, score, teamName) {
    const post1 = (side, delta) => act(() => post(`/admin/api/badminton/matches/${m.id}/point`, { side, delta }));
    const cur = m.current || { a: 0, b: 0, game: 1 };
    const side = (key, name, players) => h('div', { class: 'bd-side' },
      h('div', { class: 'bd-name' }, (m.serving === key ? h('span', { class: 'bd-serve', title: 'Serving' }) : null), h('b', {}, name), players ? h('div', { class: 'muted small' }, players) : null),
      h('div', { class: 'bd-score' }, cur[key]),
      score ? h('div', { class: 'bd-btns' }, h('button', { class: 'btn primary', onclick: () => post1(key, 1) }, '+1'), h('button', { class: 'btn', onclick: () => post1(key, -1), title: 'Take a point away' }, '−1')) : null);
    return h('div', { class: 'card bd-match' + (m.status === 'live' ? ' live' : '') },
      h('div', { class: 'bd-head' }, h('span', {}, [m.court ? `Court ${m.court}` : 'No court', m.round, m.kind].filter(Boolean).join(' · ')), h('span', { class: 'pill ' + BD_PILL[m.status] }, BD_STATUS[m.status])),
      side('a', m.teamAName, m.playersA), side('b', m.teamBName, m.playersB),
      h('div', { class: 'muted small' }, `Game ${cur.game} · games won ${m.gamesWonA}-${m.gamesWonB} · first to ${m.rules.gamesToWin}`, m.games.length ? ' · ' + m.games.map(g => `${g.a}-${g.b}`).join(', ') : ''),
      score ? h('div', { class: 'tools', style: 'margin-top:8px' },
        h('button', { class: 'btn sm', onclick: () => bdFinish(m, act, teamName) }, 'Finish or walkover'),
        h('button', { class: 'btn sm', onclick: () => bdScoreSheet(m, act) }, 'Type the score'),
        h('button', { class: 'btn sm danger', onclick: () => { if (confirm('Reset this match to 0-0 and waiting?')) act(() => post(`/admin/api/badminton/matches/${m.id}/reset`)); } }, 'Reset')) : null);
  }

  function bdScore(d, act, score, teamName) {
    const live = d.matches.filter(m => m.status === 'live');
    const next = d.matches.filter(m => m.status === 'scheduled' && m.teamA && m.teamB);
    const done = d.matches.filter(m => m.status === 'finished' || m.status === 'walkover').slice().reverse();
    if (!d.matches.length) return h('div', { class: 'card' }, h('p', {}, 'There are no matches yet. Add the teams, then make the fixtures.'));
    return h('div', {},
      h('h2', {}, `On court now (${live.length})`),
      live.length ? h('div', { class: 'bd-grid' }, live.map(m => bdMatchCard(m, d, act, score, teamName))) : h('p', { class: 'muted' }, 'No match is being played. Start the next one below.'),
      h('h2', {}, `Up next (${next.length})`),
      next.length ? table([
        { label: '#', render: m => m.matchNo }, { label: 'Court', render: m => m.court || '—' }, { label: 'Time', render: m => (m.scheduledAt ? dateTime(m.scheduledAt) : '—') },
        { label: 'Match', render: m => h('span', {}, h('b', {}, `${m.teamAName} vs ${m.teamBName}`), h('div', { class: 'muted small' }, [m.round, m.kind].filter(Boolean).join(' · '))), wrap: true },
        { label: '', render: m => (score ? h('button', { class: 'btn sm primary', onclick: e => { e.stopPropagation(); act(() => post(`/admin/api/badminton/matches/${m.id}/start`), 'Match started'); } }, 'Start') : null) },
      ], next.slice(0, 12), null) : h('p', { class: 'muted' }, 'Nothing waiting.'),
      h('h2', {}, `Results (${done.length})`),
      done.length ? h('div', { class: 'bd-grid' }, done.slice(0, 12).map(m => bdMatchCard(m, d, act, score, teamName))) : h('p', { class: 'muted' }, 'No finished matches yet.'));
  }

  function bdFinish(m, act, teamName) {
    const f = h('div', {},
      field('Winner', { name: 'winner', type: 'select', value: 'a', options: [{ value: 'a', label: teamName(m.teamA) }, { value: 'b', label: teamName(m.teamB) }] }),
      field('How did it end?', { name: 'walkover', type: 'select', value: '1', options: [{ value: '1', label: 'Walkover or retired (no full score)' }, { value: '0', label: 'Normal result' }] }),
      field('Note (optional)', { name: 'note', value: m.note || '', maxlength: 200, placeholder: 'Team B player injured' }));
    dialog('Finish the match', f, [{ label: 'Save result', kind: 'primary', run: async () => {
      const v = values(f);
      const ok = await act(() => post(`/admin/api/badminton/matches/${m.id}/finish`, { winner: v.winner, walkover: v.walkover === '1', note: v.note }), 'Result saved');
      return !ok;
    } }]);
  }

  function bdScoreSheet(m, act) {
    const rows = [1, 2, 3].map(n => { const g = m.games[n - 1]; return h('div', { class: 'bd-sheet' }, h('span', {}, `Game ${n}`),
      h('input', { name: 'a' + n, type: 'number', min: 0, max: 50, value: g ? g.a : '', 'aria-label': `Game ${n} team A` }), h('span', {}, '-'), h('input', { name: 'b' + n, type: 'number', min: 0, max: 50, value: g ? g.b : '', 'aria-label': `Game ${n} team B` })); });
    const f = h('div', {}, h('p', { class: 'muted small' }, `${m.teamAName} (left) vs ${m.teamBName} (right). Fill the games played; leave the rest empty. Use this for a score kept on paper.`), rows);
    dialog('Type the score', f, [{ label: 'Save score', kind: 'primary', run: async () => {
      const v = values(f);
      const games = [1, 2, 3].filter(n => v['a' + n] !== '' || v['b' + n] !== '').map(n => ({ a: bdNum(v['a' + n], 0), b: bdNum(v['b' + n], 0) }));
      if (!games.length) { toast('Type at least one game', true); return true; }
      const ok = await act(() => post(`/admin/api/badminton/matches/${m.id}/score`, { games }), 'Score saved');
      return !ok;
    } }]);
  }

  function bdTeams(d, act, write, el) {
    const t = d.tournament;
    return h('div', {},
      write ? h('div', { class: 'tools' },
        h('button', { class: 'btn primary', onclick: () => bdDraw(d, act) }, 'Random team draw'),
        h('button', { class: 'btn', onclick: () => bdTeamForm(null, d, act) }, '+ Add a team')) : null,
      h('p', { class: 'muted' }, 'The draw deals your players into balanced teams (strong players spread out, using the level 1 to 5 you give), or add teams and players by hand.'),
      d.teams.length ? h('div', { class: 'bd-grid' }, d.teams.map(x => h('div', { class: 'card' },
        h('div', { class: 'bd-head' }, h('b', {}, x.name), write ? h('span', {},
          h('button', { class: 'btn sm', onclick: () => bdTeamForm(x, d, act) }, 'Rename'), ' ',
          h('button', { class: 'btn sm danger', onclick: () => { if (confirm(`Delete team "${x.name}"?`)) act(() => del('/admin/api/badminton/teams/' + x.id)); } }, 'Delete')) : null),
        h('ul', { class: 'bd-players' }, x.players.map(p => h('li', {}, p.name, h('span', { class: 'muted small' }, ` level ${p.level}`), write ? h('span', {}, ' ',
          h('button', { class: 'btn sm', title: 'Move to another team', onclick: () => bdMovePlayer(p, d, act) }, 'Move'), ' ',
          h('button', { class: 'btn sm danger', onclick: () => act(() => del('/admin/api/badminton/players/' + p.id)) }, '×')) : null))),
        write ? h('button', { class: 'btn sm', onclick: () => bdPlayerForm(x, t, act) }, '+ Player') : null))) : h('div', { class: 'card' }, h('p', {}, 'No teams yet.')));
  }

  function bdTeamForm(team, d, act) {
    const f = h('div', {}, field('Team name', { name: 'name', value: team ? team.name : '', maxlength: 60, placeholder: 'Smashers' }),
      team ? null : field('Players (one per line, optional, "Name, level 1-5")', { name: 'players', type: 'textarea', maxlength: 1500 }));
    dialog(team ? 'Rename team' : 'Add a team', f, [{ label: 'Save', kind: 'primary', run: async () => {
      const v = values(f);
      const players = team ? undefined : String(v.players || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const m = /^(.*?)(?:\s*[,:;-]\s*([1-5]))?$/.exec(l); return { name: m[1], level: m[2] || 3 }; });
      const ok = await act(() => (team ? patch('/admin/api/badminton/teams/' + team.id, { name: v.name }) : post(`/admin/api/badminton/${d.tournament.id}/teams`, { name: v.name, players })), 'Saved');
      return !ok;
    } }]);
  }
  function bdPlayerForm(team, t, act) {
    const f = h('div', {}, field('Player name', { name: 'name', maxlength: 60 }), field('Level (1 beginner to 5 strong)', { name: 'level', type: 'number', min: 1, max: 5, value: '3' }));
    dialog('Add a player to ' + team.name, f, [{ label: 'Add', kind: 'primary', run: async () => {
      const v = values(f);
      const ok = await act(() => post(`/admin/api/badminton/${t.id}/players`, { teamId: team.id, name: v.name, level: bdNum(v.level, 3) }), 'Player added');
      return !ok;
    } }]);
  }
  function bdMovePlayer(p, d, act) {
    const f = h('div', {}, field('Move ' + p.name + ' to', { name: 'teamId', type: 'select', options: d.teams.map(x => ({ value: x.id, label: x.name })) }));
    dialog('Move player', f, [{ label: 'Move', kind: 'primary', run: async () => { const ok = await act(() => patch('/admin/api/badminton/players/' + p.id, { teamId: Number(values(f).teamId) }), 'Moved'); return !ok; } }]);
  }

  function bdDraw(d, act) {
    const f = h('div', {},
      field('Players (one per line: "Name, level 1-5"; level is optional and means 3)', { name: 'players', type: 'textarea', maxlength: 4000 }),
      field('Number of teams', { name: 'teams', type: 'number', min: 2, max: 32, value: '4' }),
      field('Team names (optional, separated by commas)', { name: 'names', maxlength: 500, placeholder: 'Smashers, Rockets, Titans, Falcons' }),
      field('If teams exist already', { name: 'replace', type: 'select', value: '0', options: [{ value: '0', label: 'Keep them and add these teams' }, { value: '1', label: 'Replace them (also deletes the fixtures)' }] }),
      h('p', { class: 'muted small' }, 'Every team gets at least two players. Run the draw again for a different split.'));
    dialog('Random team draw', f, [{ label: 'Draw teams', kind: 'primary', run: async () => {
      const v = values(f);
      const ok = await act(() => post(`/admin/api/badminton/${d.tournament.id}/draw`, { players: v.players, teams: bdNum(v.teams, 2), names: v.names, replace: v.replace === '1' }), 'Teams drawn');
      return !ok;
    } }]);
  }

  function bdFixtures(d, act, write, teamName) {
    const t = d.tournament;
    return h('div', {},
      write ? h('div', { class: 'tools' },
        h('button', { class: 'btn primary', onclick: () => bdGenerate(d, act) }, d.matches.length ? 'Make fixtures again' : 'Make fixtures'),
        h('button', { class: 'btn', onclick: () => bdKnockout(d, act) }, 'Next knockout round'),
        h('button', { class: 'btn', onclick: () => bdReschedule(d, act) }, 'Re-plan courts and times'),
        h('button', { class: 'btn', onclick: () => bdMatchForm(null, d, act, teamName) }, '+ Add a match')) : null,
      h('p', { class: 'muted' }, `Every team plays every other team. A "tie" is a few matches (such as singles and doubles); the team that wins more of them wins the tie. ${t.courts} court${t.courts === 1 ? '' : 's'}, ${t.minutesPerMatch} minutes a match.`),
      table([
        { label: '#', render: m => m.matchNo }, { label: 'Round', render: m => h('span', {}, m.round, m.stage === 'knockout' ? h('span', { class: 'pill warn' }, 'KO') : null) }, { label: 'Match', render: m => m.kind },
        { label: 'Teams', render: m => h('span', {}, h('b', {}, m.teamAName), ' vs ', h('b', {}, m.teamBName), m.playersA || m.playersB ? h('div', { class: 'muted small' }, [m.playersA, m.playersB].filter(Boolean).join(' vs ')) : null), wrap: true },
        { label: 'Court', render: m => m.court || '—' }, { label: 'Time', render: m => (m.scheduledAt ? dateTime(m.scheduledAt) : '—') },
        { label: 'Status', render: m => h('span', { class: 'pill ' + BD_PILL[m.status] }, BD_STATUS[m.status]) },
        { label: 'Score', render: m => (m.games.length ? m.games.map(g => `${g.a}-${g.b}`).join(', ') : '—') },
      ], d.matches, write ? m => bdMatchForm(m, d, act, teamName) : null, 'No matches yet. Make the fixtures once the teams are ready.'));
  }

  function bdGenerate(d, act) {
    const f = h('div', {},
      field('Matches in each tie (separated by commas)', { name: 'rubbers', value: 'Singles, Doubles', maxlength: 200, placeholder: "Men's Singles, Women's Singles, Mixed Doubles" }, 'For example: Singles, Doubles. One match only? Type one name.'),
      field('Rounds', { name: 'legs', type: 'select', value: '1', options: [{ value: '1', label: 'Everyone plays everyone once' }, { value: '2', label: 'Twice (home and away)' }] }),
      field('First match starts at', { name: 'startAt', type: 'datetime-local', value: d.tournament.startsAt ? localInput(d.tournament.startsAt) : '' }, 'Leave empty to plan only the order and courts.'),
      d.matches.length ? field('Existing fixtures', { name: 'replace', type: 'select', value: '1', options: [{ value: '1', label: 'Replace them (nothing has been played)' }] }) : null);
    dialog('Make the fixtures', f, [{ label: 'Make fixtures', kind: 'primary', run: async () => {
      const v = values(f);
      const ok = await act(() => post(`/admin/api/badminton/${d.tournament.id}/fixtures`, { rubbers: v.rubbers, legs: bdNum(v.legs, 1), startAt: v.startAt ? new Date(v.startAt).toISOString() : '', replace: v.replace === '1' }), 'Fixtures made');
      return !ok;
    } }]);
  }
  function bdKnockout(d, act) {
    const first = !d.matches.some(m => m.stage === 'knockout');
    const f = h('div', {}, first ? field('Teams that go into the knockout (the top of the table)', { name: 'top', type: 'select', value: '4', options: [2, 4, 8, 16].map(n => ({ value: n, label: n === 2 ? 'Top 2 (a final)' : `Top ${n}` })) }) : h('p', {}, 'Makes the next round from the winners of the last knockout round.'),
      field('Matches in each tie', { name: 'rubbers', value: 'Singles, Doubles', maxlength: 200 }));
    dialog(first ? 'Start the knockout' : 'Next knockout round', f, [{ label: 'Make the round', kind: 'primary', run: async () => {
      const v = values(f);
      const ok = await act(() => post(`/admin/api/badminton/${d.tournament.id}/knockout`, { top: bdNum(v.top, 4), rubbers: v.rubbers }), 'Round made');
      return !ok;
    } }]);
  }
  function bdReschedule(d, act) {
    const f = h('div', {}, field('Next waiting match starts at', { name: 'startAt', type: 'datetime-local', value: localInput(new Date().toISOString()) }),
      h('p', { class: 'muted small' }, 'Plans the courts and times again for matches not played yet (for example after a delay or a change in the number of courts). Matches being played stay as they are.'));
    dialog('Re-plan courts and times', f, [{ label: 'Re-plan', kind: 'primary', run: async () => {
      const v = values(f);
      const ok = await act(() => post(`/admin/api/badminton/${d.tournament.id}/reschedule`, { startAt: v.startAt ? new Date(v.startAt).toISOString() : '' }), 'Planned again');
      return !ok;
    } }]);
  }

  function bdMatchForm(m, d, act, teamName) {
    const t = d.tournament;
    const teamOpts = [{ value: '', label: 'To be decided' }].concat(d.teams.map(x => ({ value: x.id, label: x.name })));
    const courtOpts = [{ value: '', label: 'Not set' }].concat(Array.from({ length: t.courts }, (_, i) => ({ value: i + 1, label: `Court ${i + 1}` })));
    const started = m && m.status !== 'scheduled' && m.status !== 'cancelled';
    const f = h('div', {},
      field('Team A', { name: 'teamA', type: 'select', value: m && m.teamA ? m.teamA : '', options: teamOpts }, started ? 'The teams cannot change once the match has started.' : ''),
      field('Team B', { name: 'teamB', type: 'select', value: m && m.teamB ? m.teamB : '', options: teamOpts }),
      field('Match type', { name: 'kind', value: m ? m.kind : 'Singles', maxlength: 30, placeholder: "Men's Doubles" }),
      field('Round', { name: 'round', value: m ? m.round : '', maxlength: 40, placeholder: 'Round 1, Semi Final' }),
      field('Team A players (optional)', { name: 'playersA', value: m ? m.playersA : '', maxlength: 100, placeholder: 'Asha / Ben' }),
      field('Team B players (optional)', { name: 'playersB', value: m ? m.playersB : '', maxlength: 100 }),
      field('Court', { name: 'court', type: 'select', value: m && m.court ? m.court : '', options: courtOpts }),
      field('Time', { name: 'scheduledAt', type: 'datetime-local', value: m && m.scheduledAt ? localInput(m.scheduledAt) : '' }),
      field('Order in the queue (a lower number plays earlier)', { name: 'matchNo', type: 'number', min: 1, value: m ? m.matchNo : '' }),
      field('Note (optional)', { name: 'note', value: m ? m.note : '', maxlength: 200 }),
      m ? field('Status', { name: 'status', type: 'select', value: m.status === 'cancelled' ? 'cancelled' : 'scheduled', options: [{ value: 'scheduled', label: 'Waiting to be played' }, { value: 'cancelled', label: 'Cancelled' }] }, started ? 'Use Reset on the scoring screen to change a match that was played.' : '') : null);
    const body = v => ({ teamA: v.teamA === '' ? null : Number(v.teamA), teamB: v.teamB === '' ? null : Number(v.teamB), kind: v.kind, round: v.round, playersA: v.playersA, playersB: v.playersB,
      court: v.court === '' ? null : Number(v.court), scheduledAt: v.scheduledAt ? new Date(v.scheduledAt).toISOString() : '', note: v.note });
    const buttons = [{ label: 'Save', kind: 'primary', run: async () => {
      const v = values(f);
      const b = body(v);
      if (m) { if (v.matchNo !== '') b.matchNo = Number(v.matchNo); if (!started) b.status = v.status; if (started) { delete b.teamA; delete b.teamB; } }
      const ok = await act(() => (m ? patch('/admin/api/badminton/matches/' + m.id, b) : post(`/admin/api/badminton/${t.id}/matches`, b)), 'Saved');
      return !ok;
    } }];
    if (m) buttons.push({ label: 'Delete', kind: 'danger', run: async () => {
      if (!confirm('Delete this match and its score?')) return true;
      const ok = await act(() => del('/admin/api/badminton/matches/' + m.id), 'Match deleted');
      return !ok;
    } });
    dialog(m ? 'Edit match' : 'Add a match', f, buttons);
  }

  function bdTable(d) {
    return h('div', {},
      h('p', { class: 'muted' }, `A team gets ${d.tournament.tiePoints} points for each tie it wins, half for a level tie. Ties on points are split by matches won, then games, then points scored minus conceded. Knockout matches are not in this table.`),
      table([
        { label: '#', render: r => r.rank }, { label: 'Team', render: r => h('b', {}, r.name) }, { label: 'Ties played', render: r => r.played },
        { label: 'W', render: r => r.won }, { label: 'D', render: r => r.drawn }, { label: 'L', render: r => r.lost }, { label: 'Points', render: r => h('b', {}, r.points) },
        { label: 'Matches won', render: r => `${r.matchesWon}-${r.matchesLost}` }, { label: 'Games', render: r => `${r.gamesWon}-${r.gamesLost}` }, { label: 'Points scored', render: r => `${r.pointsFor}-${r.pointsAgainst}` },
      ], d.standings, null, 'Add teams to see the table.'));
  }

  function bdSettings(d, done, el) {
    const t = d ? d.tournament : null;
    const num = (name, label, value, min, max, hint) => field(label, { name, type: 'number', min, max, value: String(value) }, hint);
    const f = h('div', {},
      field('Tournament name', { name: 'name', value: t ? t.name : '', maxlength: 80, placeholder: 'Friday Smash' }),
      field('Keyword for the live page', { name: 'keyword', value: t ? t.keyword : '', maxlength: 40, placeholder: 'friday smash' }, 'What your team types to see the scores. 4 to 40 letters, numbers, spaces or dashes. Change it any time to lock out people who had the old one.'),
      field('Venue (optional)', { name: 'venue', value: t ? t.venue : '', maxlength: 100, placeholder: 'City Sports Hall' }),
      num('courts', 'Number of courts', t ? t.courts : 2, 1, 12),
      num('gamesToWin', 'Games to win a match (2 = best of 3)', t ? t.gamesToWin : 2, 1, 3),
      num('pointsToWin', 'Points in a game', t ? t.pointsToWin : 21, 5, 30),
      num('winBy', 'Win by (clear points)', t ? t.winBy : 2, 1, 2),
      num('pointCap', 'Point cap (the first to this wins)', t ? t.pointCap : 30, 5, 50),
      num('tiePoints', 'Points for winning a tie', t ? t.tiePoints : 2, 1, 6),
      num('minutesPerMatch', 'Minutes planned for a match', t ? t.minutesPerMatch : 30, 5, 180),
      field('Tournament starts (optional)', { name: 'startsAt', type: 'datetime-local', value: t && t.startsAt ? localInput(t.startsAt) : '' }),
      field('Status', { name: 'status', type: 'select', value: t ? t.status : 'draft', options: [{ value: 'draft', label: 'Not started' }, { value: 'live', label: 'Live' }, { value: 'finished', label: 'Finished' }] }),
      field('Live page', { name: 'shared', type: 'select', value: t ? (t.shared ? '1' : '0') : '1', options: [{ value: '1', label: 'On: anyone with the keyword can see it' }, { value: '0', label: 'Off: nobody can see it' }] }));
    dialog(t ? 'Tournament settings' : 'New tournament', f, [{ label: 'Save', kind: 'primary', run: async () => {
      const v = values(f);
      const b = { ...v, courts: bdNum(v.courts, 2), gamesToWin: bdNum(v.gamesToWin, 2), pointsToWin: bdNum(v.pointsToWin, 21), winBy: bdNum(v.winBy, 2), pointCap: bdNum(v.pointCap, 30),
        tiePoints: bdNum(v.tiePoints, 2), minutesPerMatch: bdNum(v.minutesPerMatch, 30), startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : '', shared: v.shared === '1' };
      const r = await guard(() => (t ? patch('/admin/api/badminton/' + t.id, b) : post('/admin/api/badminton', b)));
      if (!r) return true;
      toast('Saved');
      bdId = r.tournament.id; if (!t) bdTab = 'teams';
      badminton(el);
    } }]);
  }
  function bdAnnounce(t, act) {
    const f = h('div', {}, field('Message shown at the top of the live page', { name: 'announcement', value: t.announcement, maxlength: 200, placeholder: 'Lunch break at 1 pm. Finals at 4 pm on court 1.' }, 'Leave empty to hide it.'));
    dialog('Announcement', f, [{ label: 'Save', kind: 'primary', run: async () => { const ok = await act(() => patch('/admin/api/badminton/' + t.id, { announcement: values(f).announcement }), 'Saved'); return !ok; } }]);
  }

  const VIEWS = { overview, opportunities, atschecks: atsChecks, demos, offers, visitors, customers, candidates, licences, profiles, conversations, jobs, tokens, pricing: pricingPage, aikeys, orders, releases, messages, badminton, audit, team, account };

  // ---------- start ----------
  (async function start() {
    try { me = (await get('/admin/api/me')).admin; await refreshOpenCount(); } catch (_) { me = null; }
    render();
  })();
})();
