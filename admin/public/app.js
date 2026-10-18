// ClassCue admin dashboard. Everything shown is inserted as text (never as HTML), so a customer's name or
// message can never run code in this page.
(function () {
  'use strict';

  // ---------- tiny helpers ----------
  const root = document.getElementById('app');
  let me = null;
  let openCount = 0;
  let newOppCount = 0;
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
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format((cents || 0) / 100); }
    catch (_) { return `${((cents || 0) / 100).toFixed(2)} ${cur || ''}`; }
  };
  const date = s => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
  const dateTime = s => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const moneyList = list => (list && list.length ? list.map(r => money(r.cents, r.currency)).join(' + ') : money(0, 'USD'));
  const can = permission => ({
    'customers.write': ['owner', 'admin'], 'licence.major': ['owner', 'admin'], 'orders.write': ['owner', 'admin'],
    'releases.write': ['owner', 'admin'], 'aikeys.write': ['owner', 'admin'], 'conversations.delete': ['owner', 'admin'], 'profiles.write': ['owner', 'admin', 'support'], 'accounts.write': ['owner', 'admin'], 'jobs.write': ['owner', 'admin'], 'tokens.write': ['owner', 'admin'], 'opportunities.write': ['owner', 'admin', 'support'], 'team': ['owner'],
  }[permission] || []).includes(me.role);

  const STATUS_PILL = { default: 'good', approved: 'good', rejected: 'bad', pending: 'warn', on: 'good', off: 'bad', active: 'good', expired: 'warn', revoked: 'bad', paid: 'good', refunded: 'warn', failed: 'bad', open: 'warn', closed: '', new: 'warn', contacted: '', qualified: 'good', won: 'good', lost: 'bad', demo: 'good', interest: '', signup: '', contact: '' };
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
      h('div', { class: 'logo' }, 'C'), h('h1', {}, 'ClassCue admin'), h('p', { class: 'muted' }, 'Sign in to manage customers, licences and releases.'), form)));
    const first = form.querySelector('input'); if (first) first.focus();
  }

  // ---------- shell ----------
  const NAV = [
    ['overview', 'Overview'], ['opportunities', 'Opportunities'], ['visitors', 'Website visits'], ['customers', 'Customers'], ['candidates', 'Candidates'], ['licences', 'Licences'], ['profiles', 'Topics and resume'], ['conversations', 'Conversations'], ['jobs', 'Jobs'], ['tokens', 'AI tokens'], ['aikeys', 'AI keys'], ['orders', 'Orders'],
    ['releases', 'Releases'], ['messages', 'Support'], ['audit', 'Audit log'], ['team', 'Team'], ['account', 'My account'],
  ];

  async function render() {
    if (!me) return renderLogin();
    const content = h('main', { class: 'main', id: 'content' });
    const nav = NAV.filter(([id]) => id !== 'team' || me.role === 'owner').map(([id, label]) =>
      h('button', { class: 'nav-item', 'aria-current': id === view ? 'page' : null, onclick: () => { view = id; render(); } },
        label, id === 'messages' && openCount ? h('span', { class: 'badge-count' }, openCount) : null, id === 'opportunities' && newOppCount ? h('span', { class: 'badge-count' }, newOppCount) : null));
    root.replaceChildren(h('div', { class: 'shell' },
      h('nav', { class: 'side', 'aria-label': 'Main' }, h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'C'), 'ClassCue admin'), nav,
        h('div', { class: 'spacer' }), h('div', { class: 'who' }, `${me.email} (${me.role})`),
        h('button', { class: 'nav-item', onclick: async () => { await guard(() => post('/admin/api/logout')); me = null; render(); } }, 'Sign out')),
      content));
    await guard(() => VIEWS[view](content));
  }

  async function refreshOpenCount() {
    try { openCount = (await get('/admin/api/messages?status=open')).messages.length; newOppCount = (await get('/admin/api/opportunities?status=new')).counts.new; } catch (_) { /* ignore */ }
  }

  // ---------- overview ----------
  async function overview(el) {
    const o = await get('/admin/api/overview');
    openCount = o.openMessages;
    newOppCount = o.website.newOpportunities;
    const stat = (label, num, sub) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, num), sub ? h('div', { class: 'sub' }, sub) : null);
    const max = Math.max(1, ...o.signupSeries.map(s => s.count));
    const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'New customers per day, last 30 days' },
      o.signupSeries.map(s => { const i = h('i', { class: s.count ? '' : 'zero', title: `${s.date}: ${s.count}` }); i.style.height = Math.max(2, (s.count / max) * 100) + '%'; return i; }));
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
  async function customers(el, query = '') {
    const { customers: rows } = await get('/admin/api/customers?q=' + encodeURIComponent(query));
    el.replaceChildren(
      head('Customers', searchBox(v => customers(el, v), 'Search name, email, organisation', query),
        can('customers.write') ? h('button', { class: 'btn primary', onclick: () => customerForm(null, () => customers(el, query)) }, '+ New customer') : null),
      table([
        { label: 'Email', render: r => r.email }, { label: 'Name', render: r => r.name || '—' }, { label: 'Organisation', render: r => r.organisation || '—' },
        { label: 'Licences', render: r => r.licence_count }, { label: 'Paid', render: r => money(r.paid_cents) }, { label: 'Joined', render: r => date(r.created_at) },
      ], rows, r => customerDetail(r.id, () => customers(el, query)), query ? 'No customers match your search.' : 'No customers yet. Add one, or record an order.'));
  }

  function customerForm(existing, done) {
    const f = h('div', {},
      field('Email', { name: 'email', type: 'email', required: true, value: existing ? existing.email : '' }),
      h('div', { class: 'row2' }, field('Name', { name: 'name', value: existing ? existing.name : '' }), field('Organisation', { name: 'organisation', value: existing ? existing.organisation : '' })),
      field('Country', { name: 'country', value: existing ? existing.country : '' }),
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
    const message = `Hello ${c.name || ''},\n\nYour ClassCue account is ready.\nSign in at: ${where}\nEmail: ${r.email}\nPassword: ${r.password}\n\nYou will be asked to choose your own password when you first sign in.`.replace('Hello ,', 'Hello,');
    dialog('Login created', h('div', {},
      h('p', {}, 'Send these details to the customer. The password is shown only now; make a new one if it is lost.'),
      h('dl', { class: 'kv' }, h('dt', {}, 'Email'), h('dd', { class: 'mono' }, r.email), h('dt', {}, 'Password'), h('dd', { class: 'mono', style: 'font-size:18px;font-weight:700' }, r.password),
        h('dt', {}, 'Sign in at'), h('dd', {}, where)),
      h('div', { class: 'msg-body' }, message)), [
      { label: 'Copy message', kind: 'primary', closes: false, run: async () => { try { await navigator.clipboard.writeText(message); toast('Copied'); } catch (_) { toast('Select the text and copy it', true); } return true; } },
      { label: 'Done', run: () => {} }]);
  }

  async function customerDetail(id, done) {
    const d = await get(`/admin/api/customers/${id}`);
    const c = d.customer;
    let closeDetail = () => {};
    const login = await accountSection(c, () => { closeDetail(); customerDetail(id, done); });
    const body = h('div', {},
      h('dl', { class: 'kv' }, h('dt', {}, 'Email'), h('dd', {}, c.email), h('dt', {}, 'Name'), h('dd', {}, c.name || '—'), h('dt', {}, 'Organisation'), h('dd', {}, c.organisation || '—'),
        h('dt', {}, 'Country'), h('dd', {}, c.country || '—'), h('dt', {}, 'Joined'), h('dd', {}, dateTime(c.created_at)), h('dt', {}, 'Notes'), h('dd', {}, c.notes || '—')),
      h('h3', {}, 'Licences'),
      d.licences.length ? d.licences.map(l => h('div', { class: 'list-item' }, h('span', { class: 'mono' }, l.key), h('span', {}, `${l.plan} · `, pill(l.effective_status), ` · ${l.expires_at ? 'to ' + date(l.expires_at) : 'lifetime'}`))) : h('p', { class: 'muted' }, 'None.'),
      h('h3', { style: 'margin-top:14px' }, 'Orders'),
      d.orders.length ? d.orders.map(o => h('div', { class: 'list-item' }, h('span', {}, `#${o.id} · ${o.plan} · ${date(o.created_at)}`), h('span', {}, money(o.amount_cents, o.currency), ' ', pill(o.status)))) : h('p', { class: 'muted' }, 'None.'),
      login);
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

  // ---------- website visits ----------
  async function visitors(el, days = 30) {
    const a = await get('/admin/api/analytics?days=' + days);
    const range = h('select', { 'aria-label': 'Period', onchange: e => visitors(el, Number(e.target.value)) }, [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']].map(([v, l]) => h('option', { value: v }, l)));
    range.value = String(days);
    const stat = (label, num, sub) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'num' }, num), sub ? h('div', { class: 'sub' }, sub) : null);
    const max = Math.max(1, ...a.series.map(s => s.visitors));
    const bars = h('div', { class: 'bars', role: 'img', 'aria-label': 'Visitors per day' },
      a.series.map(s => { const i = h('i', { class: s.visitors ? '' : 'zero', title: s.date + ': ' + s.visitors + ' visitors, ' + s.views + ' page views' }); i.style.height = Math.max(2, (s.visitors / max) * 100) + '%'; return i; }));
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

  // ---------- topics and resume per customer (Live Class's AI uses them to choose the area of its answers) ----------
  async function profiles(el, query = '') {
    const { customers: all } = await get('/admin/api/profiles');
    const term = query.trim().toLowerCase();
    const rows = term ? all.filter(r => [r.email, r.name, r.organisation, ...r.topics].join(' ').toLowerCase().includes(term)) : all;
    el.replaceChildren(
      head('Topics and resume', searchBox(v => profiles(el, v), 'Search customer or topic', query)),
      h('p', { class: 'muted' }, 'Set what each customer\'s questions are about. Live Class receives the topics and the resume with its licence check (at start and every 30 minutes), and the AI uses them to decide the area of its answers.'),
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
      h('p', { class: 'muted small' }, 'Live Class gets the changes on its next licence check: when it starts, or within 30 minutes while it runs.'));
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
    'jobsearch.failed': '⚠️ AI job search failed', 'jobprep.created': '📘 Prepared for a job', 'tokens.claimed': '⚡ Asked for more AI tokens', 'tokens.granted': '⚡ Got AI tokens', download: '⬇️ Downloaded',
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
          { label: 'Required', render: r => h('b', {}, r.skill) }, { label: 'Weight', render: r => `${r.weight}%` },
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
        (p.interviewQuestions || []).length ? [h('h4', {}, 'Likely interview questions'), h('ol', { class: 'small' }, p.interviewQuestions.map(x => h('li', {}, x)))] : null,
        (p.tips || []).length ? [h('h4', {}, 'Tips'), h('ul', { class: 'small' }, p.tips.map(x => h('li', {}, x)))] : null));
      prepBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    el.replaceChildren(
      head(c.name || c.email, h('button', { class: 'btn', onclick: back }, '← All candidates')),
      h('div', { class: 'card' },
        h('dl', { class: 'kv' },
          h('dt', {}, 'Email'), h('dd', {}, c.email), h('dt', {}, 'Organisation'), h('dd', {}, c.organisation || '—'),
          h('dt', {}, 'Website login'), h('dd', {}, !c.login.exists ? 'No login yet' : c.login.disabled ? 'Turned off' : `Active · last sign-in ${c.login.lastLogin ? dateTime(c.login.lastLogin) : 'never'}`),
          h('dt', {}, 'Last active'), h('dd', {}, c.lastActive ? `${dateTime(c.lastActive)} (${ago(c.lastActive)})` : '—'),
          h('dt', {}, 'AI actions'), h('dd', {}, `${c.aiActions || 0} in total`)),
        h('div', { class: 'small muted', style: 'margin-bottom:6px' }, `Career toolkit progress: ${c.done} of 5 steps`), tracker),

      section('Resume',
        !r ? h('p', { class: 'muted' }, 'No resume uploaded yet.') : h('div', {},
          h('p', {}, h('b', {}, r.fileName || 'Pasted resume'), h('span', { class: 'muted' }, ` · ${r.chars.toLocaleString()} characters · uploaded ${dateTime(r.uploadedAt)}`)),
          h('div', { class: 'actions' }, dlLink(id, 'original', null, 'Uploaded resume (.txt)'), r.ats ? dlLink(id, 'ats', null, 'ATS-friendly resume (.docx)') : null),
          h('details', {}, h('summary', { class: 'small' }, 'Preview the uploaded text'), h('pre', { class: 'mono small', style: 'white-space:pre-wrap' }, r.preview + (r.chars > r.preview.length ? '\n…' : ''))),
          r.ats ? h('div', { class: 'cand-ats' },
            h('h3', {}, 'ATS check ', scorePill(r.ats.score), h('span', { class: 'small muted' }, `  ${dateTime(r.ats.checkedAt)}`)),
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
        ], d.preps, null, 'No preparation plans yet. They appear when the candidate presses "Prepare" on a job.'),
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
      h('p', { class: 'muted' }, 'AI tokens used by website customers (Career toolkit, AI Job search, Prepare for this job). Set the daily allowance, offer token packs, and answer requests for more.'),
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

  // ---------- Live Class conversations (saved by the app when the class ends) ----------
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
      h('p', { class: 'muted' }, 'Every Live Class session is saved here when the teacher presses End: what was heard, and each question with its answer.'),
      table([
        { label: 'Date and time', render: r => dateTime(r.started_at) }, { label: 'Length', render: r => duration(r.duration_sec) },
        { label: 'Customer', render: r => r.customer_name || r.customer_email }, { label: 'Computer', render: r => r.device_name || '—' },
        { label: 'Questions', render: r => r.question_count },
        { label: 'First question', wrap: true, render: r => (r.first_question ? (r.first_question.length > 80 ? r.first_question.slice(0, 80) + '…' : r.first_question) : '—') },
      ], rows, r => conversationDetail(r.id, () => conversations(el, filters)), q || from || to ? 'No conversations match.' : 'No conversations yet. They appear here when a Live Class session ends.'));
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
    dialog(`Live Class · ${dateTime(v.started_at)}`, body, buttons).el.classList.add('wide');
  }

  function downloadConversation(v, items) {
    const lines = [`Live Class conversation`, `Started: ${dateTime(v.started_at)}`, `Ended: ${dateTime(v.ended_at)} (${duration(v.duration_sec)})`,
      `Customer: ${v.customer_email}`, `Computer: ${v.device_name || '-'}`, v.subject ? `Subject: ${v.subject}` : '', '', 'QUESTIONS AND ANSWERS', ''];
    for (const it of items) lines.push(`${it.position}. [${clock(it.asked_at)}] ${it.question}`, it.status === 'done' ? it.answer : '(no answer)', '');
    lines.push('', 'EVERYTHING THAT WAS HEARD', '', ...v.transcript.map(p => `[${clock(p.at)}] ${p.text}`));
    const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/plain' })), download: `live-class-${v.started_at.slice(0, 16).replace(/[T:]/g, '-')}.txt` });
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

  const VIEWS = { overview, opportunities, visitors, customers, candidates, licences, profiles, conversations, jobs, tokens, aikeys, orders, releases, messages, audit, team, account };

  // ---------- start ----------
  (async function start() {
    try { me = (await get('/admin/api/me')).admin; await refreshOpenCount(); } catch (_) { me = null; }
    render();
  })();
})();
