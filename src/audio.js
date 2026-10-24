// Synthesized sounds (no audio files needed).
let ctx = null, master = null, noiseBuf = null;

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch { ctx = null; }
}

function tone(freq, dur, { type = 'sine', vol = 0.3, slide = 0, delay = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
}

function noise(dur, { freq = 2000, q = 1, vol = 0.3, attack = 0.002, type = 'bandpass', sweep = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(50, freq + sweep), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + dur + 0.02);
}

export const sfx = {
  hit(power, smash) {
    noise(0.06, { freq: 3200, q: 1.5, vol: 0.45 + power * 0.3 });
    tone(900 + power * 400, 0.06, { type: 'triangle', vol: 0.3, slide: -350 });
    if (smash) { noise(0.25, { freq: 900, q: 0.7, vol: 0.4, sweep: -600 }); tone(160, 0.2, { vol: 0.35, slide: -80 }); }
  },
  swoosh() { noise(0.22, { freq: 600, q: 1.2, vol: 0.18, attack: 0.04, sweep: 1800 }); },
  land() { noise(0.08, { freq: 400, q: 0.8, vol: 0.25 }); tone(180, 0.08, { vol: 0.15, slide: -60 }); },
  net() { noise(0.16, { freq: 700, q: 0.6, vol: 0.3 }); },
  point() { [0, 4, 7, 12].forEach((s, i) => tone(587 * 2 ** (s / 12), 0.2, { type: 'triangle', vol: 0.18, delay: i * 0.07 })); },
  lose() { tone(392, 0.18, { type: 'square', vol: 0.07, slide: -120 }); tone(262, 0.3, { type: 'square', vol: 0.07, slide: -90, delay: 0.14 }); },
  cheer(i = 0.5) { noise(1.3 + i, { freq: 1300, q: 0.5, vol: 0.12 + i * 0.18, attack: 0.15 }); },
  ui() { tone(880, 0.06, { type: 'triangle', vol: 0.2 }); tone(1320, 0.08, { type: 'triangle', vol: 0.15, delay: 0.04 }); },
  connect() { [0, 7, 12].forEach((s, i) => tone(660 * 2 ** (s / 12), 0.14, { type: 'triangle', vol: 0.16, delay: i * 0.08 })); },
  win() { [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => tone(523 * 2 ** (s / 12), 0.25, { type: 'triangle', vol: 0.16, delay: i * 0.09 })); },
};
