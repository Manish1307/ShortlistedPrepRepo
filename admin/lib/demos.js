'use strict';
// Free 1-on-1 demo sessions: which time slots exist (Monday to Saturday, hourly, India time) and which are taken.
// A slot is stored as its India date ("2026-11-05") and start time ("15:00"); slot_at ("2026-11-05T15:00") sorts by time.

const DAYS_AHEAD = 14;
const HOURS = [10, 11, 12, 14, 15, 16, 17, 18];   // 13:00 is the lunch break
const NOTICE_MINUTES = 120;                        // the earliest slot starts two hours from now
const IST_OFFSET_MS = 330 * 60 * 1000;
const ACTIVE = ['booked', 'confirmed'];            // statuses that hold a slot

const pad = n => String(n).padStart(2, '0');
const istParts = ms => { const d = new Date(ms + IST_OFFSET_MS); return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, day: d.getUTCDay() }; };
const istNow = (ms = Date.now()) => { const d = new Date(ms + IST_OFFSET_MS); return `${istParts(ms).date}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

/** All bookable slots from now, as [{ date, label, times: ['10:00', ...] }], minus the ones already taken. */
function openSlots(db, ms = Date.now()) {
  const earliest = istNow(ms + NOTICE_MINUTES * 60 * 1000);
  const last = istParts(ms + DAYS_AHEAD * 86400000).date;
  const taken = new Set(db.prepare(`SELECT slot_at FROM demo_bookings WHERE status IN ('booked','confirmed') AND slot_at >= ? AND slot_at <= ?`).all(earliest, last + 'T99').map(r => r.slot_at));
  const out = [];
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const { date, day } = istParts(ms + i * 86400000);
    if (day === 0) continue;
    const times = HOURS.map(h => `${pad(h)}:00`).filter(t => `${date}T${t}` >= earliest && !taken.has(`${date}T${t}`));
    if (times.length) out.push({ date, times });
  }
  return out;
}

/** Throws a message string if the date and time are not a real, future, working-hours slot. */
function checkSlot(date, time, ms = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:00$/.test(time)) return 'Please pick a time slot';
  const when = new Date(date + 'T00:00:00Z');
  if (Number.isNaN(when.getTime()) || when.toISOString().slice(0, 10) !== date) return 'Please pick a time slot';
  if (when.getUTCDay() === 0 || !HOURS.includes(Number(time.slice(0, 2)))) return 'That time is outside our demo hours';
  if (`${date}T${time}` < istNow(ms + NOTICE_MINUTES * 60 * 1000)) return 'That slot has already passed. Please pick another one.';
  if (date > istParts(ms + DAYS_AHEAD * 86400000).date) return 'Please pick a slot in the next two weeks';
  return '';
}

module.exports = { openSlots, checkSlot, ACTIVE, HOURS, DAYS_AHEAD };
