'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// A title="..." tooltip is drawn by Windows as its own little window, which a screen share can capture even
// though the assistant window is hidden. The page must never use one.
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the assistant window page has no title="..." attributes', () => {
  const html = read('notes-window.html').replace(/<title>[\s\S]*?<\/title>/, '');   // the document title is not a tooltip
  const hits = html.match(/\stitle\s*=/g) || [];
  assert.equal(hits.length, 0, 'found ' + hits.length + ' title attribute(s)');
});

test('the assistant window scripts never set a title, tooltip or hover text', () => {
  for (const file of ['renderer/notes-ui.js', 'renderer/capture.js']) {
    const code = read(file);
    assert.ok(!/\.title\s*=/.test(code), file + ' sets .title');
    assert.ok(!/setAttribute\(\s*['"]title['"]/.test(code.replace(/removeAttribute\([^)]*\)/g, '').replace(/hasAttribute\([^)]*\)/g, '').replace(/getAttribute\([^)]*\)/g, '')),
      file + ' sets a title attribute');
  }
  assert.match(read('renderer/notes-ui.js'), /function stopTooltips\(\)/, 'the guard that strips late titles is in place');
});

test('nothing in the assistant window opens a separate Windows dialog', () => {
  const page = read('renderer/notes-ui.js');
  assert.ok(!/\b(window\.)?(confirm|alert|prompt)\s*\(/.test(page), 'confirm/alert/prompt open native boxes');
  const main = read('main.js');
  assert.ok(!/dialog\.(showSaveDialog|showOpenDialog|showMessageBox|showErrorBox)/.test(main), 'the main process opens a native dialog');
});

test('the real mouse pointer is always hidden over the assistant window: no switch, no shortcut, no resize edges', () => {
  assert.match(read('notes-window.html'), /<body class="nocursor">/, 'always on from the first moment');
  assert.ok(!/hideCursor|sHideCursor/.test(read('notes-window.html') + read('renderer/notes-ui.js') + read('main.js') + read('src/config.js')), 'there is no setting to turn it off');
  assert.ok(!/Shift\+H/.test(read('main.js')), 'no shortcut to turn it off');
  assert.match(read('main.js'), /resizable: false/, 'no resize edges (Windows draws its own pointer there)');
  assert.match(read('notes-window.html'), /body\.nocursor \* \{ cursor: none !important; \}/);
  assert.match(read('notes-window.html'), /body\.nocursor \.titlebar \{ -webkit-app-region: no-drag; \}/, 'the title bar is not an OS drag area');
});
