// Builds prep.html and live.html from the drawing helpers and recorder in intro.html plus the scenes below.
// Run: node docs/video/gen.js     then record: npx electron docs/video/record.js prep   (and: live)
const fs = require('fs');
const path = require('path');
const intro = fs.readFileSync(path.join(__dirname, 'intro.html'), 'utf8');
const head = intro.slice(0, intro.indexOf('// 1. the problem'));
const tail = intro.slice(intro.indexOf('function draw(t)')).replace(/scenes\[5\]/g, 'scenes[scenes.length - 1]').replace(/webm/g, 'webm');

const helpers = `
function wrap(s, maxW, size, weight) { g.font = (weight || 400) + ' ' + size + 'px ' + SANS; const out = []; let line = ''; s.split(' ').forEach(w => { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }); if (line) out.push(line); return out; }
function typed(s, p) { return s.slice(0, Math.floor(s.length * clamp(p))); }
function tick(x, y, ok) { g.beginPath(); g.arc(x, y, 16, 0, 7); g.fillStyle = ok ? GREEN : ORANGE; g.fill(); text(ok ? '✓' : '!', x, y + 7, 20, '#fff', { weight: 800, align: 'center' }); }
function title(n, s, sub, t) { text(n, 70, 110, 60, ORANGE, { font: SERIF, weight: 700 }); text(s, 130, 110, 48, INK, { font: SERIF, weight: 700 }); if (sub) { g.globalAlpha = fadeIn(t, .2); text(sub, 70, 165, 27, MUTED); g.globalAlpha = 1; } }
function cta(t, line1, line2, url, note) {
  bg(NAVY); const a = fadeIn(t, .2, .7); g.globalAlpha = a; logo(W / 2 - 27, 90);
  lines(line1, W / 2, 260, 60, '#fff', 74, { font: SERIF, weight: 700, align: 'center' }); text(line2, W / 2, 360, 28, '#cfc9ee', { align: 'center' }); g.globalAlpha = 1;
  g.globalAlpha = fadeIn(t, 1.2, .6); g.font = '800 40px ' + SANS; const w = g.measureText(url).width + 90; rr((W - w) / 2, 410, w, 84, 42); g.fillStyle = ORANGE; g.fill(); text(url, W / 2, 466, 40, '#fff', { weight: 800, align: 'center' }); g.globalAlpha = 1;
  g.globalAlpha = fadeIn(t, 2.2, .6); text(note, W / 2, 566, 26, '#cfc9ee', { align: 'center' }); g.globalAlpha = 1;
}
`;

const prep = `
function p1(t) {
  bg(NAVY); logo(60, 50); text('ShortlistPrep', 128, 90, 30, '#fff', { font: SERIF, weight: 700 });
  const a = fadeIn(t, .3, .7); g.globalAlpha = a;
  lines(['Interview coming up?'], 90, 290 + (1 - a) * 30, 78, '#fff', 90, { font: SERIF, weight: 700 }); g.globalAlpha = 1;
  g.globalAlpha = fadeIn(t, 1.8, .6); lines(['Nervous about', '“Tell me about yourself”?'], 90, 380, 52, '#ffd9c7', 66, { font: SERIF, weight: 700 }); g.globalAlpha = 1;
  g.globalAlpha = fadeIn(t, 3.6, .6); pill('Practise it first', 90, 540, ORANGE, '#fff', 28); g.globalAlpha = 1;
}
function p2(t) {
  bg(TINT); title('1', 'A mock interview from your resume', 'Questions are made from your own resume, so practice feels real.', t);
  const k = ease(seg(t, .5, 1.2)); g.globalAlpha = k; card(70, 215, 600, 330);
  text('Question 1', 100, 262, 20, MUTED, { weight: 700 }); lines(wrap('Tell me about a project you built.', 540, 30, 700), 100, 305, 30, INK, 40, { weight: 700 });
  rr(100, 360, 540, 150, 12); g.fillStyle = '#f4f2fb'; g.fill();
  const ans = typed('I built a Library App in Java with Spring Boot. It handled 500 books and cut search time from 2 minutes to 5 seconds.', seg(t, 1.6, 4.4));
  lines(wrap(ans, 500, 22, 400), 120, 398, 22, INK, 32); g.globalAlpha = 1;
  const fb = [['Structure', true, 'Clear start, middle and end'], ['Examples', true, 'You gave real numbers'], ['Confidence', false, 'Cut the filler words']];
  fb.forEach((r, i) => { const q = ease(seg(t, 5 + i * .9, 5.7 + i * .9)); g.globalAlpha = q; card(720 + (1 - q) * 60, 215 + i * 112, 490, 96, { r: 12 }); tick(762 + (1 - q) * 60, 263 + i * 112, r[1]); text(r[0], 795 + (1 - q) * 60, 255 + i * 112, 26, INK, { weight: 800 }); text(r[2], 795 + (1 - q) * 60, 286 + i * 112, 20, MUTED); }); g.globalAlpha = 1;
}
function p3(t) {
  bg('#fff'); title('2', 'Your “Tell me about yourself”', 'Build your introduction, then check it against your resume.', t);
  const k = ease(seg(t, .5, 1.2)); g.globalAlpha = k; card(70, 215, 620, 340);
  text('Your introduction', 100, 262, 20, MUTED, { weight: 700 });
  const intro = 'I am Neha, a junior Java developer. I built a Library App with Spring Boot and I am looking to grow in backend development.';
  lines(wrap(typed(intro, seg(t, 1.2, 4.4)), 560, 26, 500), 100, 310, 26, INK, 38, { weight: 500 }); g.globalAlpha = 1;
  const rows = [['Name and current role', true], ['Skills match your resume', true], ['Add one result with a number', false]];
  text('Checked against your resume', 740, 250, 24, INK, { weight: 800 });
  rows.forEach((r, i) => { const q = ease(seg(t, 4.6 + i * .9, 5.3 + i * .9)); g.globalAlpha = q; card(740 + (1 - q) * 60, 275 + i * 90, 470, 74, { r: 12 }); tick(780 + (1 - q) * 60, 312 + i * 90, r[1]); text(r[0], 812 + (1 - q) * 60, 321 + i * 90, 23, INK, { weight: 600 }); }); g.globalAlpha = 1;
  g.globalAlpha = fadeIn(t, 8, .6); pill('A strong first answer sets the tone', 70, 566, NAVY, '#fff', 24); g.globalAlpha = 1;
}
function p4(t) {
  bg(TINT); title('3', 'Feedback on every answer', 'Sharpen your weak topics until they feel easy.', t);
  card(70, 215, 760, 330);
  [['Structure', 82], ['Examples', 64], ['Confidence', 74]].forEach((r, i) => { const v = ease(seg(t, .8 + i * .5, 2.2 + i * .5)) * r[1]; text(r[0], 110, 290 + i * 90, 26, INK, { weight: 700 }); text(Math.round(v) + '%', 790, 290 + i * 90, 26, INK, { weight: 800, align: 'right' }); rr(110, 306 + i * 90, 680, 16, 8); g.fillStyle = '#eceaf5'; g.fill(); rr(110, 306 + i * 90, Math.max(16, 680 * v / 100), 16, 8); g.fillStyle = r[1] > 70 ? GREEN : ORANGE; g.fill(); });
  g.globalAlpha = fadeIn(t, 3.2, .6); card(870, 215, 340, 330); text('Weak topic', 900, 262, 20, MUTED, { weight: 700 }); lines(['Examples with', 'numbers'], 900, 315, 32, INK, 42, { font: SERIF, weight: 700 }); pill('Practise again', 900, 440, ORANGE, '#fff', 22); g.globalAlpha = 1;
}
function p5(t) { cta(t, ['Practise before', 'the real thing'], 'Mock interviews and your introduction, made from your resume.', 'shortlistprep.com', 'Free to join. No card needed.'); }
const scenes = [
  { a: 0, b: 6, f: p1 },
  { a: 6, b: 16, f: p2, cap: 'Mock interview questions from your own resume' },
  { a: 16, b: 27, f: p3, cap: 'Build “Tell me about yourself” and check it' },
  { a: 27, b: 34, f: p4, cap: 'Feedback on structure, examples and confidence' },
  { a: 34, b: 40, f: p5 }
];
`;

const live = `
function l1(t) {
  bg(NAVY); logo(60, 50); text('ShortlistPrep', 128, 90, 30, '#fff', { font: SERIF, weight: 700 });
  const a = fadeIn(t, .3, .7); g.globalAlpha = a;
  lines(['The real interview.', 'Your mind goes blank.'], 90, 280 + (1 - a) * 30, 74, '#fff', 90, { font: SERIF, weight: 700 }); g.globalAlpha = 1;
  g.globalAlpha = fadeIn(t, 2.2, .6); text('What if you had help, based on your own resume?', 90, 500, 30, '#cfc9ee'); g.globalAlpha = 1;
  g.globalAlpha = fadeIn(t, 3.8, .6); pill('Meet the desktop apps', 90, 550, ORANGE, '#fff', 28); g.globalAlpha = 1;
}
function l2(t) {
  bg(TINT); title('1', 'It listens', 'Speech is transcribed on your own PC.', t);
  const k = ease(seg(t, .4, 1.1)); g.globalAlpha = k; card(70, 215, 1140, 300);
  rr(100, 245, 70, 70, 35); g.fillStyle = '#eef0ff'; g.fill(); text('HR', 135, 290, 26, NAVY, { weight: 800, align: 'center' });
  text('Interviewer', 195, 270, 20, MUTED, { weight: 700 });
  lines(wrap(typed('Why should we hire you for this role?', seg(t, 1.2, 3.2)), 900, 36, 600), 195, 318, 36, INK, 46, { weight: 600 }); g.globalAlpha = 1;
  // microphone level bars
  const on = seg(t, 1, 1.4) * (1 - seg(t, 3.6, 4)); for (let i = 0; i < 28; i++) { const h = 8 + on * (10 + 26 * Math.abs(Math.sin(t * 7 + i * .9))); rr(195 + i * 16, 455 - h / 2, 8, h, 4); g.fillStyle = ORANGE; g.fill(); }
  g.globalAlpha = fadeIn(t, 4.2, .5); pill('Question spotted', 195 + 0, 470, GREEN, '#fff', 22); g.globalAlpha = 1;
  g.globalAlpha = fadeIn(t, 6, .6); pill('Transcribed on your PC', 70, 560, NAVY, '#fff', 24); g.globalAlpha = 1;
}
function l3(t) {
  bg('#fff'); title('2', 'It suggests an answer from your resume', 'Example only. Your answer is yours to say.', t);
  card(70, 215, 1140, 130); text('Why should we hire you for this role?', 100, 292, 32, INK, { font: SERIF, weight: 700 });
  const a = ease(seg(t, .6, 1)); g.globalAlpha = a; card(70, 370, 1140, 240, { stroke: ORANGE }); text('Suggested answer', 100, 412, 20, ORANGE, { weight: 800 });
  const ans = 'I bring hands-on Java and Spring Boot experience from my Library App project, where I cut search time from two minutes to five seconds. I learn quickly, and I would like to bring that to your backend team.';
  lines(wrap(typed(ans, seg(t, 1.2, 7)), 1040, 26, 500), 100, 456, 26, INK, 38, { weight: 500 }); g.globalAlpha = 1;
}
function l4(t) {
  bg(TINT); title('3', 'Practise first, then go live', 'Use the same apps in a mock interview or the real one.', t);
  const k = ease(seg(t, .5, 1.2)); g.globalAlpha = k; card(70, 225, 540, 280); text('Mock interview', 100, 290, 36, INK, { font: SERIF, weight: 700 }); lines(wrap('Practise with questions from your resume. No pressure.', 480, 24, 400), 100, 340, 24, MUTED, 34); pill('Start here', 100, 430, GREEN, '#fff', 22); g.globalAlpha = 1;
  const k2 = ease(seg(t, 1.6, 2.3)); g.globalAlpha = k2; card(670, 225, 540, 280); text('Real interview', 700, 290, 36, INK, { font: SERIF, weight: 700 }); lines(wrap('Suggested answers on screen when you want them.', 480, 24, 400), 700, 340, 24, MUTED, 34); pill('When you are ready', 700, 430, ORANGE, '#fff', 22); g.globalAlpha = 1;
  g.globalAlpha = fadeIn(t, 3.6, .6); text('You stay in charge of what you say.', W / 2, 580, 30, INK, { weight: 700, align: 'center' }); g.globalAlpha = 1;
}
function l5(t) { cta(t, ['Get ready with', 'live support'], 'Download the ShortlistPrep desktop apps.', 'shortlistprep.com', 'Free to join. No card needed.'); }
const scenes = [
  { a: 0, b: 6, f: l1 },
  { a: 6, b: 16, f: l2, cap: 'It listens and spots the question' },
  { a: 16, b: 27, f: l3, cap: 'A suggested answer from your resume' },
  { a: 27, b: 33, f: l4, cap: 'Practise first, then use it live' },
  { a: 33, b: 38, f: l5 }
];
`;

function build(name, scenes, dur) {
  const h = head.replace('DURATION = 45', 'DURATION = ' + dur).replace('<title>ShortlistPrep introduction</title>', '<title>ShortlistPrep ' + name + '</title>');
  fs.writeFileSync(path.join(__dirname, name + '.html'), h + helpers + scenes + tail);
}
build('prep', prep, 40);
build('live', live, 38);
console.log('built prep.html and live.html');
