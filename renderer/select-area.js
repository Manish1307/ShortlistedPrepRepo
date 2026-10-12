// Selection screen for screen capture: shows the frozen picture of the screen; the teacher drags a box around the
// question. Enter = the whole screen, Esc or right-click = cancel.
(function () {
  'use strict';
  const api = window.selectAPI;
  const $ = id => document.getElementById(id);
  const shot = $('shot'), box = $('box'), lx = $('lx'), ly = $('ly');
  let start = null;
  let sent = false;

  const send = r => { if (!sent) { sent = true; api.done(r); } };
  const rectFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });

  function paint(r) {
    box.style.left = r.x + 'px'; box.style.top = r.y + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  }

  document.addEventListener('mousemove', e => {
    lx.style.top = e.clientY + 'px';
    ly.style.left = e.clientX + 'px';
    if (start) paint(rectFrom(start, { x: e.clientX, y: e.clientY }));
  });

  document.addEventListener('mousedown', e => {
    if (e.button === 2) return send(null);
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY };
    paint(rectFrom(start, start));
    document.body.classList.add('drawing');
  });

  document.addEventListener('mouseup', e => {
    if (!start || e.button !== 0) return;
    const r = rectFrom(start, { x: e.clientX, y: e.clientY });
    start = null;
    if (r.width >= 8 && r.height >= 8) return send(r);
    document.body.classList.remove('drawing');    // a plain click: let the teacher try again
  });

  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') send(null);
    else if (e.key === 'Enter') send({ full: true });
  });

  api.onImage(url => {
    shot.onload = () => requestAnimationFrame(() => api.ready());   // shown only once the picture is painted: no flash
    shot.src = url;
  });
})();
