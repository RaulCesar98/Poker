// Sons sintetizados com Web Audio API (sem arquivos externos)
const Sound = (() => {
  let ctx = null, master = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem('pk_muted') === '1'; } catch (e) {}

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  const ok = () => !muted && ac();

  function noise(t, dur, { type = 'bandpass', freq = 2000, q = 1, gain = 0.5, attack = 0.002, sweepTo = null } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
  }

  function tone(t, freq, dur, { type = 'sine', gain = 0.3, attack = 0.005, endFreq = null } = {}) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // carta deslizando na mesa
  function card(delay = 0) {
    if (!ok()) return;
    const t = ctx.currentTime + delay;
    noise(t, 0.09, { type: 'highpass', freq: 1800, gain: 0.35, sweepTo: 5000 });
    noise(t + 0.05, 0.05, { type: 'bandpass', freq: 900, q: 2, gain: 0.25 });
  }

  // virar carta
  function flip(delay = 0) {
    if (!ok()) return;
    const t = ctx.currentTime + delay;
    noise(t, 0.06, { type: 'bandpass', freq: 2500, q: 0.8, gain: 0.4 });
    noise(t + 0.03, 0.04, { type: 'lowpass', freq: 600, gain: 0.3 });
  }

  // uma ficha batendo em outra
  function clink(t, vol = 1) {
    const base = 3000 + Math.random() * 1500;
    tone(t, base, 0.07, { gain: 0.12 * vol, attack: 0.001 });
    tone(t, base * 1.48, 0.05, { gain: 0.07 * vol, attack: 0.001 });
    noise(t, 0.03, { type: 'highpass', freq: 5000, gain: 0.15 * vol, attack: 0.001 });
  }

  function chips(n = 3, delay = 0) {
    if (!ok()) return;
    let t = ctx.currentTime + delay;
    for (let i = 0; i < n; i++) {
      clink(t, 1 - i * 0.08);
      t += 0.035 + Math.random() * 0.04;
    }
  }

  // batidinha na mesa (check)
  function check() {
    if (!ok()) return;
    const t = ctx.currentTime;
    for (const dt of [0, 0.13]) {
      tone(t + dt, 160, 0.09, { type: 'sine', gain: 0.5, attack: 0.001, endFreq: 70 });
      noise(t + dt, 0.04, { type: 'lowpass', freq: 900, gain: 0.35, attack: 0.001 });
    }
  }

  function fold() {
    if (!ok()) return;
    const t = ctx.currentTime;
    noise(t, 0.28, { type: 'bandpass', freq: 700, q: 0.7, gain: 0.35, attack: 0.04, sweepTo: 3500 });
  }

  function shuffle() {
    if (!ok()) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 14; i++) noise(t + i * 0.035, 0.03, { type: 'highpass', freq: 2500, gain: 0.18 });
    noise(t + 0.55, 0.08, { type: 'lowpass', freq: 500, gain: 0.4 });
  }

  function turn() {
    if (!ok()) return;
    const t = ctx.currentTime;
    tone(t, 784, 0.25, { type: 'sine', gain: 0.22 });
    tone(t + 0.12, 1175, 0.4, { type: 'sine', gain: 0.22 });
  }

  function tick() {
    if (!ok()) return;
    tone(ctx.currentTime, 1400, 0.04, { type: 'square', gain: 0.05, attack: 0.001 });
  }

  function allin() {
    if (!ok()) return;
    const t = ctx.currentTime;
    tone(t, 110, 0.7, { type: 'sawtooth', gain: 0.08, attack: 0.15, endFreq: 220 });
    tone(t, 165, 0.7, { type: 'triangle', gain: 0.12, attack: 0.15, endFreq: 330 });
    chips(8, 0.1);
  }

  function win() {
    if (!ok()) return;
    const t = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone(t + i * 0.1, f, 0.5, { type: 'triangle', gain: 0.18 });
    });
    tone(t + 0.4, 1318.5, 0.8, { type: 'sine', gain: 0.12 });
    chips(10, 0.35);
  }

  function lose() {
    if (!ok()) return;
    const t = ctx.currentTime;
    tone(t, 392, 0.3, { type: 'triangle', gain: 0.12 });
    tone(t + 0.18, 311, 0.5, { type: 'triangle', gain: 0.12 });
  }

  function chat() {
    if (!ok()) return;
    tone(ctx.currentTime, 1500, 0.08, { gain: 0.06 });
  }

  function toggle() {
    muted = !muted;
    try { localStorage.setItem('pk_muted', muted ? '1' : '0'); } catch (e) {}
    if (!muted) { ac(); chips(2); }
    return muted;
  }

  return { unlock: ac, card, flip, chips, check, fold, shuffle, turn, tick, allin, win, lose, chat, toggle, isMuted: () => muted };
})();
