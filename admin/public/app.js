// ClassCue admin dashboard. Everything shown is inserted as text (never as HTML), so a customer's name or
// message can never run code in this page.
(function () {
  'use strict';

  // ---------- tiny helpers ----------
  const root = document.getElementById('app');
  let me = null;
  let openCount = 0;
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
    for (const c of children.flat()) {
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
    'releases.write': ['owner', 'admin'], 'team': ['owner'],
  }[permission] || []).includes(me.role);

  const STATUS_PILL = { active: 'good', expired: 'warn', revoked: 'bad', paid: 'good', refunded: 'warn', failed: 'bad', open: 'warn', closed: '' };
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
    ['overview', 'Overview'], ['customers', 'Customers'], ['licences', 'Licences'], ['orders', 'Orders'],
    ['releases', 'Releases'], ['messages', 'Support'], ['audit', 'Audit log'], ['team', 'Team'], ['account', 'My account'],
  ];

  async function render() {
    if (!me) return renderLogin();
    const content = h('main', { class: 'main', id: 'content' });
    const nav = NAV.filter(([id]) => id !== 'team' || me.role === 'owner').map(([id, label]) =>
      h('button', { class: 'nav-item', 'aria-current': id === view ? 'page' : null, onclick: () => { view = id; render(); } },
        label, id === 'messages' && openCount ? h('span', { class: 'badge-count' }, openCount) : null));
    root.replaceChildren(h('div', { class: 'shell' },
      h('nav', { class: 'side', 'aria-label': 'Main' }, h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'C'), 'ClassCue admin'), nav,
        h('div', { class: 'spacer' }), h('div', { class: 'who' }, `${me.email} (${me.role})`),
        h('button', { class: 'nav-item', onclick: async () => { await guard(() => post('/admin/api/logout')); me = null; render(); } }, 'Sign out')),
      content));
    await guard(() => VIEWS[view](content));
  }

  async function refreshOpenCount() {
    try { openCount = (await get('/admin/api/messages?status=open')).messages.length; } catch (_) { /* ignore */ }
  }

  // ---------- overview ----------
  async function overview(el) {
    const o = await get('/admin/api/overview');
    openCount = o.openMessages;
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
        stat('Refunded', moneyList(o.refundedTotal))),
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

  async function customerDetail(id, done) {
    const d = await get(`/admin/api/customers/${id}`);
    const c = d.customer;
    const body = h('div', {},
      h('dl', { class: 'kv' }, h('dt', {}, 'Email'), h('dd', {}, c.email), h('dt', {}, 'Name'), h('dd', {}, c.name || '—'), h('dt', {}, 'Organisation'), h('dd', {}, c.organisation || '—'),
        h('dt', {}, 'Country'), h('dd', {}, c.country || '—'), h('dt', {}, 'Joined'), h('dd', {}, dateTime(c.created_at)), h('dt', {}, 'Notes'), h('dd', {}, c.notes || '—')),
      h('h3', {}, 'Licences'),
      d.licences.length ? d.licences.map(l => h('div', { class: 'list-item' }, h('span', { class: 'mono' }, l.key), h('span', {}, `${l.plan} · `, pill(l.effective_status), ` · ${l.expires_at ? 'to ' + date(l.expires_at) : 'lifetime'}`))) : h('p', { class: 'muted' }, 'None.'),
      h('h3', { style: 'margin-top:14px' }, 'Orders'),
      d.orders.length ? d.orders.map(o => h('div', { class: 'list-item' }, h('span', {}, `#${o.id} · ${o.plan} · ${date(o.created_at)}`), h('span', {}, money(o.amount_cents, o.currency), ' ', pill(o.status)))) : h('p', { class: 'muted' }, 'None.'));
    const buttons = [];
    if (can('licence.major')) buttons.push({ label: 'Issue licence', run: (close) => { close(); licenceForm(c.id, done); return true; }, closes: false });
    if (can('customers.write')) buttons.push({ label: 'Edit', run: (close) => { close(); customerForm(c, done); return true; }, closes: false });
    buttons.push({ label: 'Close', run: () => {} });
    dialog(c.name || c.email, body, buttons);
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
    const act = (action, extra, message) => guard(async () => { await patch(`/admin/api/licences/${id}`, { action, ...extra }); toast(message || 'Done'); done(); });
    const body = h('div', {},
      h('dl', { class: 'kv' }, h('dt', {}, 'Key'), h('dd', { class: 'mono' }, l.key), h('dt', {}, 'Customer'), h('dd', {}, l.customer_email),
        h('dt', {}, 'Plan'), h('dd', {}, `${l.plan} (${l.kind})`), h('dt', {}, 'Status'), h('dd', {}, pill(l.effective_status)),
        h('dt', {}, 'Expires'), h('dd', {}, l.expires_at ? dateTime(l.expires_at) : 'Lifetime'), h('dt', {}, 'Computers allowed'), h('dd', {}, String(l.max_devices)),
        h('dt', {}, 'Created'), h('dd', {}, dateTime(l.created_at)), h('dt', {}, 'Note'), h('dd', {}, l.note || '—')),
      h('h3', {}, `Activated computers (${d.devices.length})`),
      d.devices.length ? d.devices.map(dev => h('div', { class: 'list-item' },
        h('span', {}, `${dev.name || 'Computer'} · v${dev.app_version || '?'} · last seen ${dateTime(dev.last_seen)}`),
        h('button', { class: 'btn sm', onclick: async () => { await act('removeDevice', { deviceId: dev.device_id }, 'Computer removed'); close(); } }, 'Remove'))) : h('p', { class: 'muted' }, 'Not activated on any computer yet.'));
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

  const VIEWS = { overview, customers, licences, orders, releases, messages, audit, team, account };

  // ---------- start ----------
  (async function start() {
    try { me = (await get('/admin/api/me')).admin; await refreshOpenCount(); } catch (_) { me = null; }
    render();
  })();
})();
