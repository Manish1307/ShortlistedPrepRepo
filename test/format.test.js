'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toLines, toReadingText } = require('../src/format');

test('a paragraph becomes one statement per line (the example that was too hard to read)', () => {
  const paragraph = 'A custom connector is a way to bring any external REST API into Power Platform so you can call it from Power Automate, Power Apps, or Power Virtual Agents. You define the connector by providing the API’s URL, authentication method, and the actions (operations) you want to expose. Then the connector appears like a built‑in action you can drag into a flow or use in an app.';
  const lines = toLines(paragraph);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^A custom connector is a way/);
  assert.match(lines[1], /^You define the connector/);
  assert.match(lines[2], /^Then the connector appears/);
  assert.ok(lines.every(l => /[.!?]$/.test(l)), 'every line is a complete statement');
});

test('numbers, .NET, abbreviations and quotes do not cause a wrong split', () => {
  assert.deepEqual(toLines('Version 3.5 was released. It supports .NET Core.'), ['Version 3.5 was released.', 'It supports .NET Core.']);
  assert.deepEqual(toLines('Use a tool, e.g. Postman, to test it. Then check the result.'), ['Use a tool, e.g. Postman, to test it.', 'Then check the result.']);
  assert.deepEqual(toLines('It is called "REST." The name stands for something.'), ['It is called "REST."', 'The name stands for something.']);
  assert.deepEqual(toLines('Is it free? Yes! It costs nothing.'), ['Is it free?', 'Yes!', 'It costs nothing.']);
  assert.deepEqual(toLines('Mr. Lee asked about vs. code.'), ['Mr. Lee asked about vs. code.']);
});

test('list items and existing line breaks are kept; blank lines are dropped', () => {
  const text = 'First do this.\n\n- Open the portal.\n- Click Create.\n1. Save it.\n2) Test it.';
  assert.deepEqual(toLines(text), ['First do this.', '- Open the portal.', '- Click Create.', '1. Save it.', '2) Test it.']);
});

test('applying it twice changes nothing, and partial text while streaming is handled', () => {
  const once = toReadingText('One thing. Another thing. A third');
  assert.equal(toReadingText(once), once);
  assert.equal(once, 'One thing.\nAnother thing.\nA third');
  assert.equal(toReadingText(''), '');
  assert.equal(toReadingText(undefined), '');
});

test('a very long sentence is cut at a semicolon', () => {
  const long = 'You create the connector in the maker portal and give it a clear name for everyone; then you add the host address and the base path of the service you want to call every day.';
  const lines = toLines(long);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\.$/);
  assert.match(lines[1], /^Then you add/);
});
