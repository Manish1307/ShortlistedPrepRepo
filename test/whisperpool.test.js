'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { WhisperPool } = require('../src/stt/whisperPool');

const sleep = ms => new Promise(r => setTimeout(r, ms));
class FakeServer extends EventEmitter {
  constructor(name, ms = 40) { super(); this.name = name; this.ms = ms; this.ready = false; this.active = 0; this.peak = 0; this.restarts = 0; }
  async start() { this.ready = true; }
  async transcribe() { this.active++; this.peak = Math.max(this.peak, this.active); await sleep(this.ms); this.active--; return this.name; }
  async restart() { this.restarts++; }
  stop() { this.ready = false; }
}

test('pool: requests go to different engines at the same time, never two at once on one engine', async () => {
  const a = new FakeServer('a'), b = new FakeServer('b');
  const pool = new WhisperPool([a, b]);
  await pool.start();
  assert.equal(pool.ready, true);
  const out = await Promise.all([pool.transcribe(Buffer.alloc(1)), pool.transcribe(Buffer.alloc(1)), pool.transcribe(Buffer.alloc(1)), pool.transcribe(Buffer.alloc(1))]);
  assert.equal(out.length, 4);
  assert.equal(a.peak, 1);
  assert.equal(b.peak, 1);
  assert.ok(out.includes('a') && out.includes('b'));
});

test('pool: a live preview is refused unless a spare engine is free, so it never delays real text', async () => {
  const a = new FakeServer('a', 80), b = new FakeServer('b', 80);
  const pool = new WhisperPool([a, b]);
  await pool.start();
  const real = pool.transcribe(Buffer.alloc(1));                            // one engine is busy with real speech
  await sleep(10);
  await assert.rejects(pool.transcribe(Buffer.alloc(1), { onlyIfIdle: true }), /busy/);   // the other must stay free
  await real;
  assert.equal(await pool.transcribe(Buffer.alloc(1), { onlyIfIdle: true }), 'a');        // both idle: the preview may run
});

test('pool: restart restarts every engine', async () => {
  const a = new FakeServer('a'), b = new FakeServer('b');
  const pool = new WhisperPool([a, b]);
  await pool.start();
  await pool.restart();
  assert.deepEqual([a.restarts, b.restarts], [1, 1]);
});
