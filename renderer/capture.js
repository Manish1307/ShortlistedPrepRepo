// Captures audio in the private notes window and delivers 16 kHz mono 16-bit frames.
//   source 'system': everything the computer plays (the meeting: Teams, Skype, Meet...). Windows only.
//   source 'mic'   : the microphone (macOS, or when testing by speaking).
//   source 'both' : the meeting AND the microphone mixed together (so the teacher's own voice is heard too).
(function () {
  'use strict';

  // Runs on the audio thread: mixes to mono and hands back blocks of 100 ms.
  const WORKLET_CODE = `
    class PcmTap extends AudioWorkletProcessor {
      constructor() { super(); this.buf = new Float32Array(1600); this.n = 0; }
      process(inputs) {
        const ch = inputs[0];
        if (!ch || !ch.length) return true;
        const left = ch[0], right = ch[1];
        for (let i = 0; i < left.length; i++) {
          this.buf[this.n++] = right ? (left[i] + right[i]) * 0.5 : left[i];
          if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
        }
        return true;
      }
    }
    registerProcessor('pcm-tap', PcmTap);
  `;

  async function openStream(source) {
    if (source === 'both') return [await openStream('system'), await openStream('mic')];
    if (source === 'system') {
      // The main process answers this request with the system-audio loopback (see main.js).
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t); }); // only the sound is wanted
      if (!stream.getAudioTracks().length) {
        throw new Error('No system audio was provided. System-audio capture works on Windows; choose "Microphone" in Settings on other systems.');
      }
      return stream;
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  }

  /**
   * @param {'system'|'mic'} source
   * @param {{onFrame: (buf: ArrayBuffer) => void, onLevel?: (rms: number) => void, onEnded?: () => void}} handlers
   * @returns {Promise<{stop: () => Promise<void>}>}
   */
  async function start(source, { onFrame, onLevel, onEnded, onStalled }) {
    const opened = await openStream(source);
    const streams = Array.isArray(opened) ? opened : [opened];
    const stream = { getTracks: () => streams.flatMap(s => s.getTracks()), getAudioTracks: () => streams.flatMap(s => s.getAudioTracks()) };
    const ctx = new AudioContext({ sampleRate: 16000 }); // the browser resamples the input to 16 kHz for us
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      await ctx.resume();

      const inputs = streams.map(s => ctx.createMediaStreamSource(s)); // several inputs into one node are summed
      const tap = new AudioWorkletNode(ctx, 'pcm-tap');
      const silent = ctx.createGain(); // keeps the graph running without playing anything back
      silent.gain.value = 0;
      inputs.forEach(i => i.connect(tap)); tap.connect(silent); silent.connect(ctx.destination);

      let lastFrameAt = Date.now();
      tap.port.onmessage = event => {
        lastFrameAt = Date.now();
        const f32 = event.data;
        const i16 = new Int16Array(f32.length);
        let sum = 0;
        for (let i = 0; i < f32.length; i++) {
          const v = Math.max(-1, Math.min(1, f32[i]));
          i16[i] = v < 0 ? v * 32768 : v * 32767;
          sum += v * v;
        }
        if (onLevel) onLevel(Math.sqrt(sum / f32.length));
        onFrame(i16.buffer);
      };

      // A browser audio engine can fall asleep (it was started without a click, or the window lost focus): wake it up.
      const keepAlive = setInterval(() => {
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        if (Date.now() - lastFrameAt > 6000 && onStalled) { lastFrameAt = Date.now(); onStalled(); }
      }, 1500);

      let stopped = false;
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        clearInterval(keepAlive);
        stream.getTracks().forEach(t => t.stop());
        try { tap.port.onmessage = null; inputs.forEach(i => i.disconnect()); tap.disconnect(); } catch (_) { /* already disconnected */ }
        try { await ctx.close(); } catch (_) { /* already closed */ }
      };
      stream.getAudioTracks().forEach(t => t.addEventListener('ended', () => { stop(); if (onEnded) onEnded(); }));
      return { stop };
    } catch (err) {
      stream.getTracks().forEach(t => t.stop());
      try { await ctx.close(); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  window.LiveCapture = { start };
})();
