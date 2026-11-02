// Free 1-on-1 demo (book-demo.html): pick a day and a time from the open slots, then book.
(function () {
  'use strict';
  var form = document.getElementById('demo-form');
  if (!form) return;
  var meta = document.querySelector('meta[name="api-url"]');
  var API = meta ? meta.getAttribute('content').replace(/\/+$/, '') : '';
  var days = document.getElementById('slot-days'), times = document.getElementById('slot-times'), chosen = document.getElementById('slot-chosen');
  var out = form.querySelector('.form-result'), picked = { date: '', time: '' }, openSlots = [];

  function visitorId() {
    try { var id = localStorage.getItem('sp_vid'); if (id && /^[A-Za-z0-9-]{8,64}$/.test(id)) return id; } catch (e) { /* storage blocked */ }
    return '';
  }
  function chip(html, on, click) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'slot-chip'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.innerHTML = html; b.addEventListener('click', click);
    return b;
  }
  function dayParts(iso) {
    var d = new Date(iso + 'T00:00:00');
    return { wk: d.toLocaleDateString('en-IN', { weekday: 'short' }), dm: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), full: d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }) };
  }
  function timeText(t) { var h = Number(t.slice(0, 2)); return (h % 12 || 12) + ':00 ' + (h < 12 ? 'AM' : 'PM'); }
  function say(cls, msg) { out.className = 'form-result ' + cls; out.textContent = msg; }

  function draw() {
    days.replaceChildren(); times.replaceChildren();
    openSlots.forEach(function (s) {
      var p = dayParts(s.date);
      days.appendChild(chip(p.wk + '<small>' + p.dm + '</small>', picked.date === s.date, function () { picked = { date: s.date, time: '' }; draw(); }));
    });
    var day = openSlots.filter(function (s) { return s.date === picked.date; })[0];
    if (day) day.times.forEach(function (t) { times.appendChild(chip(timeText(t), picked.time === t, function () { picked.time = t; draw(); })); });
    form.date.value = picked.date; form.time.value = picked.time;
    chosen.textContent = picked.date && picked.time ? 'Your slot: ' + dayParts(picked.date).full + ', ' + timeText(picked.time) + ' IST' : '';
  }
  function load() {
    if (!API) { days.textContent = 'Booking is not connected yet. Please email us to book a slot.'; return; }
    fetch(API + '/api/demo/slots').then(function (r) { return r.json(); }).then(function (j) {
      openSlots = j.slots || [];
      if (picked.date && !openSlots.some(function (s) { return s.date === picked.date && s.times.indexOf(picked.time) >= 0; })) picked = { date: '', time: '' };
      if (!openSlots.length) { days.textContent = 'All slots are taken for now. Please email us and we will find a time.'; return; }
      draw();
    }).catch(function () { days.textContent = 'We could not load the open slots. Please refresh, or email us to book.'; });
  }
  load();

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!picked.date || !picked.time) return say('bad', 'Please pick a day and a time first.');
    if (!form.name.value.trim() || !form.email.value.trim() || !form.phone.value.trim()) return say('bad', 'Please fill in your name, email and phone number.');
    var button = form.querySelector('button[type=submit]');
    button.disabled = true; say('', 'Booking…');
    var booked = dayParts(picked.date).full + ', ' + timeText(picked.time) + ' IST';
    fetch(API + '/api/demo/book', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.name.value, email: form.email.value, phone: form.phone.value, goal: form.goal.value, website: form.website.value, date: picked.date, time: picked.time, visitor: visitorId(), page: location.pathname })
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.'); }); })
      .then(function () { say('ok', 'You are booked for ' + booked + '. We will email you the meeting link.'); form.reset(); picked = { date: '', time: '' }; load(); })
      .catch(function (err) { say('bad', String(err.message || err)); load(); })
      .then(function () { button.disabled = false; });
  });
})();
