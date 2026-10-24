// Phone controller: pairs its own SpacetimeDB identity to one seat of a match, calibrates,
// detects swings from motion sensors and sends them through reducers. Feedback (hits, score,
// secret moves, stamina) arrives through subscriptions, views and event tables.
import { connect, call, tables } from './stdb.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const first = it => { for (const x of it) return x; return undefined; };
const params = new URLSearchParams(location.search);
const code = (params.get('code') || '').toUpperCase();
const seat = Number(params.get('seat') || 0);

// ---------- tuning ----------
const DEFAULT_CAL = { gentle: 1.6, hard: 3.6 };   // swing intensity units (~1 = 360°/s of wrist rotation)
const PEAK_WINDOW_MS = 70;                         // how long we watch for the peak before reporting
const COOLDOWN_MS = 350;
const AIM_RANGE_DEG = 32;                          // phone yaw that maps to full left/right aim
const DIR_DEG = 18;                                // pitch change during a swing that counts as up/down
const TWIST_RATIO = 0.6;                           // share of rotation around the phone's long axis that counts as a slice

const cal = { ...DEFAULT_CAL, ...loadCal() };
let center = null;           // heading (deg) when "Set center" was tapped
let heading = null, pitch = 0, aim = 0;
const pitchLog = [];         // recent { t, pitch } samples, to see which way a swing travelled
let stage = 'connect';       // connect | motion | center | gentle | hard | play
let calPeaks = [];
let tapMode = false;

function loadCal() { try { return JSON.parse(localStorage.getItem('birdie.cal')) || {}; } catch { return {}; } }
function saveCal() { try { localStorage.setItem('birdie.cal', JSON.stringify({ gentle: cal.gentle, hard: cal.hard })); } catch { /* storage unavailable */ } }

// ---------- screens ----------
const STEPS = ['s-connect', 's-motion', 's-center', 's-swing', 's-play'];
function show(id) { for (const s of STEPS) $(s).classList.toggle('hidden', s !== id); }

// ---------- SpacetimeDB ----------
let conn = null, paired = false, matchId = 0;
const act = (name, args = {}) => call(conn, name, args, msg => {
  if (!paired) { $('connTitle').textContent = 'Can\'t join'; $('connText').textContent = msg; }
  else setPrompt(msg);
});

connect({
  subs: [tables.match, tables.myShot, tables.myDevice, tables.mySecret, tables.myStamina, tables.myRead, tables.hitEvent, tables.rallyEvent, tables.readEvent, tables.noticeEvent],
  wire(c) {
    conn = c;
    for (const t of ['match', 'myShot', 'myDevice', 'mySecret', 'myStamina', 'myRead']) {
      c.db[t].onInsert(refresh); c.db[t].onDelete(refresh); c.db[t].onUpdate?.(refresh);
    }
    c.db.hitEvent.onInsert((_c, e) => {
      if (e.matchId !== matchId) return;
      if (e.seat === seat) feedback(true, e.shown, e.grade, e.smash);
      else setPrompt(e.smash ? 'Incoming SMASH!' : '');
    });
    c.db.rallyEvent.onInsert((_c, e) => {
      if (e.matchId !== matchId) return;
      const won = e.winner === seat;
      setPrompt(won ? `Point! ${e.reason}` : `Lost the point — ${e.reason}`);
      buzz(won ? [40, 60, 40] : 120);
    });
    c.db.noticeEvent.onInsert((_c, e) => { if (e.matchId === matchId) setPrompt(e.text); });
    c.db.readEvent.onInsert((_c, e) => {
      if (e.matchId !== matchId) return;
      if (e.seat === seat) { setPrompt(e.correct ? `🔮 READ IT! It was a ${e.actual} — next swing is sharper` : `Misread — it was a ${e.actual} (−5 stamina)`); buzz(e.correct ? [20, 30, 20, 30, 60] : 80); }
      else if (e.correct) setPrompt(`😱 They read your ${e.actual}!`);
    });
  },
  onReady(c) {
    conn = c;
    if (!code) { $('connTitle').textContent = 'No match code'; $('connText').textContent = 'Scan the QR code on the laptop screen.'; return; }
    act('pairPhone', { code, seat });
    refresh();
  },
  onStatus(text) { if (text) { setPrompt(text); if (stage === 'connect') $('connTitle').textContent = text; } },
});

function refresh() {
  if (!conn) return;
  const d = first(conn.db.myDevice.iter());
  const nowPaired = !!(d && d.kind === 'phone' && d.matchId !== 0);
  if (nowPaired && !paired) {
    paired = true;
    if (stage === 'connect') { stage = 'motion'; show('s-motion'); }
    sendStatus();
  }
  paired = nowPaired;
  matchId = d?.matchId || 0;
  const m = matchId ? [...conn.db.match.iter()].find(x => x.id === matchId) : null;
  if (m) {
    const me = seat === 0 ? m.scoreA : m.scoreB, op = seat === 0 ? m.scoreB : m.scoreA;
    $('pScore').textContent = `${me} – ${op}`;
    const opp = (seat === 0 ? m.nameB : m.nameA) || 'opponent';
    if (m.status === 'lobby') setPrompt((seat === 0 ? m.readyA : m.readyB) ? `Ready — waiting for ${opp}` : 'Swing to ready up!');
    else if (m.status === 'countdown') setPrompt('Get ready…');
    else if (m.status === 'paused') setPrompt(`Paused — ${m.pausedReason}`);
    else if (m.status === 'over') setPrompt(m.winner === seat ? '🏆 You win! Swing for a rematch' : `${opp} wins — swing for a rematch`);
    else if (m.phase === 'serve') setPrompt(m.server === seat ? 'Your serve — swing!' : `${opp} serving…`);
  }
  const sec = first(conn.db.mySecret.iter());
  for (const b of document.querySelectorAll('#pSecrets button')) {
    const mv = b.dataset.move;
    const used = sec ? (mv === 'power' ? sec.usedPower : mv === 'curve' ? sec.usedCurve : sec.usedFeint) : false;
    b.classList.toggle('armed', !!sec && sec.armed === mv);
    b.classList.toggle('used', used);
    b.disabled = !sec || used;
  }
  // Reads: only while the opponent is about to hit (their serve, or your shot is flying to them).
  // my_shot only ever holds your own shot, so "it exists" means the shuttle is heading to the opponent.
  const shot = m && first(conn.db.myShot.iter());
  const canRead = !!m && m.status === 'playing' && ((m.phase === 'rally' && !!shot && shot.seq === m.shotSeq) || (m.phase === 'serve' && m.server !== seat));
  const rd = first(conn.db.myRead.iter());
  for (const b of document.querySelectorAll('#pReads button')) {
    b.disabled = !canRead;
    b.classList.toggle('armed', canRead && !!rd && rd.guess === b.dataset.read);
  }
  const st = first(conn.db.myStamina.iter());
  $('pStamina').style.width = `${st ? st.value : 100}%`;
  $('pStamina').classList.toggle('low', !!st && st.value < 30);
}

function feedback(hit, shot, grade, smash) {
  $('pLast').textContent = shot || '';
  $('pGrade').textContent = grade || '';
  const pad = $('pad');
  pad.classList.remove('hit', 'flash'); void pad.offsetWidth;
  if (hit) { pad.classList.add('hit', 'flash'); buzz(smash ? [40, 30, 80] : grade === 'PERFECT!' ? [30, 40, 60] : 35); setTimeout(() => pad.classList.remove('hit'), 250); }
}
function setPrompt(t) { $('pPrompt').textContent = t; }
function sendStatus() { if (paired) act('phoneStatus', { ready: stage === 'play', tapMode }); }
function buzz(p) { try { navigator.vibrate?.(p); } catch { /* not supported */ } }

// ---------- sensors ----------
async function enableMotion() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('Motion permission was denied. Enable it in Settings → Safari → Motion & Orientation Access.');
    }
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission().catch(() => {});
    }
    if (!window.isSecureContext) throw new Error('Motion sensors need HTTPS. Open the https:// link from the QR code.');
    window.addEventListener('devicemotion', onMotion);
    window.addEventListener('deviceorientation', onOrientation);
    // Confirm sensors actually deliver data
    const ok = await new Promise(res => {
      const t = setTimeout(() => res(false), 1500);
      window.addEventListener('devicemotion', function once(e) {
        if (e.rotationRate || e.acceleration || e.accelerationIncludingGravity) { clearTimeout(t); window.removeEventListener('devicemotion', once); res(true); }
      });
    });
    if (!ok) throw new Error('No motion data from this device. Use tap mode instead.');
    stage = 'center'; show('s-center');
    $('btnUseSaved').classList.toggle('hidden', !localStorage.getItem?.('birdie.cal'));
  } catch (err) {
    const e = $('motionErr'); e.textContent = err.message || String(err); e.classList.remove('hidden');
  }
}

function onOrientation(e) {
  if (e.alpha == null) return;
  const r = Math.PI / 180;
  const cA = Math.cos(e.alpha * r), sA = Math.sin(e.alpha * r);
  const cB = Math.cos(e.beta * r), sB = Math.sin(e.beta * r);
  // Direction the top of the phone points (device +Y axis in world frame, per W3C rotation order Z-X'-Y'')
  const x = -cB * sA, y = cA * cB;
  if (Math.hypot(x, y) > 0.2) heading = Math.atan2(x, y) / r;
  pitch = Math.asin(clamp(sB, -1, 1)) / r;   // how far the top of the phone points up (−90…90), independent of grip
  const now = performance.now();
  pitchLog.push({ t: now, pitch });
  while (pitchLog.length && now - pitchLog[0].t > 600) pitchLog.shift();
  if (center !== null && heading !== null) {
    let d = heading - center;
    d = ((d + 540) % 360) - 180;
    aim = clamp(d / AIM_RANGE_DEG, -1, 1);
  }
}

// Swing intensity: whichever is stronger, wrist rotation or linear acceleration.
let swing = null, lastSwingEnd = 0, meterVal = 0;
function onMotion(e) {
  const rr = e.rotationRate;
  const gyro = rr ? Math.hypot(rr.alpha || 0, rr.beta || 0, rr.gamma || 0) / 360 : 0;
  let acc = 0;
  if (e.acceleration && e.acceleration.x != null) acc = Math.hypot(e.acceleration.x, e.acceleration.y, e.acceleration.z) / 14;
  else if (e.accelerationIncludingGravity) {
    const g = e.accelerationIncludingGravity;
    acc = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81) / 14;
  }
  // rotationRate.gamma spins around the phone's long axis: a wrist twist (slice) rather than a swing.
  const twist = rr && gyro > 0 ? Math.abs(rr.gamma || 0) / 360 / gyro : 0;
  feed(Math.max(gyro, acc), performance.now(), twist);
}

function trigger() {
  return stage === 'play' ? Math.max(0.7, cal.gentle * 0.55) : 0.9;
}

function feed(s, now, twist = 0) {
  meterVal = Math.max(meterVal * 0.9, s);
  if (swing) {
    if (s > swing.peak) { swing.peak = s; swing.twist = twist; }
    const age = now - swing.start;
    if (age >= PEAK_WINDOW_MS || (age > 25 && s < swing.peak * 0.6)) {
      emitSwing(swing.peak, age, swing.aim, gestureOf(swing));
      swing = null; lastSwingEnd = now;
    }
  } else if (s > trigger() && now - lastSwingEnd > COOLDOWN_MS) {
    swing = { start: now, peak: s, aim, twist, pitch0: pitchAt(now - 80) };   // aim is sampled at swing start, before the motion skews it
  }
}

function pitchAt(t) {
  for (let i = pitchLog.length - 1; i >= 0; i--) if (pitchLog[i].t <= t) return pitchLog[i].pitch;
  return pitchLog.length ? pitchLog[0].pitch : pitch;
}
// Chop down = smash/attack, swing up = lift/clear, twist = slice drop, otherwise a flat forward swing.
function gestureOf(sw) {
  const d = pitch - sw.pitch0;
  const dir = d < -DIR_DEG ? 'down' : d > DIR_DEG ? 'up' : 'flat';
  return { dir, slice: sw.twist > TWIST_RATIO && dir === 'flat' };
}

function powerFromPeak(peak) {
  const lo = cal.gentle * 0.85, hi = Math.max(cal.hard, cal.gentle * 1.4);
  return clamp((peak - lo) / (hi - lo), 0, 1.2);
}

function emitSwing(peak, lagMs, swingAim, gesture = { dir: 'flat', slice: false }) {
  if (stage === 'gentle' || stage === 'hard') return recordCalibration(peak);
  if (stage !== 'play') return;
  act('phoneSwing', { power: +powerFromPeak(peak).toFixed(3), aim: +swingAim.toFixed(3), lag: Math.round(lagMs), dir: gesture.dir, slice: !!gesture.slice, tap: false });
  $('pGesture').textContent = gesture.slice ? '↻ twist' : { down: '↓ chop', up: '↑ up', flat: '→ flat' }[gesture.dir];
}

// ---------- calibration ----------
function startSwingStep(kind) {
  stage = kind; calPeaks = [];
  show('s-swing');
  $('swingTitle').textContent = kind === 'gentle' ? '3 gentle swings' : '3 HARD swings';
  $('swingText').textContent = kind === 'gentle'
    ? 'Hold tight! Swing softly, like a delicate drop shot.'
    : 'Now go big — swing like you\'re smashing! (Hold on tight.)';
  updateDots();
  sendStatus();
}
function updateDots() { [...$('swingDots').children].forEach((d, i) => d.classList.toggle('on', i < calPeaks.length)); }
function recordCalibration(peak) {
  calPeaks.push(peak); updateDots(); buzz(25);
  if (calPeaks.length < 3) return;
  const med = [...calPeaks].sort((a, b) => a - b)[1];
  if (stage === 'gentle') { cal.gentle = clamp(med, 0.9, 4); setTimeout(() => startSwingStep('hard'), 500); }
  else {
    cal.hard = Math.max(med, cal.gentle * 1.4);
    saveCal();
    setTimeout(startPlay, 500);
  }
}

function startPlay() {
  stage = 'play'; show('s-play');
  $('tapHint').textContent = tapMode ? 'Tap: top = smash · middle = clear · bottom = lift · left/right = aim' : 'Swing your phone — or tap here';
  sendStatus();
  navigator.wakeLock?.request('screen').catch(() => {});
}

// ---------- aim stream (throttled: only real changes, ~6/s) + meters ----------
let sentAim = 0, sentPitch = 0, lastAimSend = 0;
setInterval(() => {
  const now = performance.now();
  if (paired && stage === 'play' && !tapMode && now - lastAimSend > 160 && (Math.abs(aim - sentAim) > 0.04 || Math.abs(pitch - sentPitch) > 8)) {
    lastAimSend = now; sentAim = aim; sentPitch = pitch;
    act('phoneAim', { aim: +aim.toFixed(3), pitch: Math.round(pitch) });
  }
  const m = Math.min(100, (meterVal / Math.max(cal.hard, 2)) * 100);
  $('calMeter').style.width = `${m}%`;
  $('playMeter').style.width = `${m}%`;
  $('aimDot').style.left = `${50 + aim * 45}%`;
  meterVal *= 0.85;
}, 33);

// ---------- tap fallback (also works alongside sensors) ----------
// Tap position sets the shot: left/right = aim, higher on the pad = harder.
$('pad').addEventListener('pointerdown', e => {
  if (stage !== 'play') return;
  const r = e.currentTarget.getBoundingClientRect();
  const tapAim = clamp(((e.clientX - r.left) / r.width - 0.5) * 2.2, -1, 1);
  const y = (e.clientY - r.top) / r.height;
  const [tapPower, dir] = y < 0.25 ? [1, 'down'] : y > 0.75 ? [0.7, 'up'] : [0.6, 'flat'];
  act('phoneSwing', { power: tapPower, aim: +tapAim.toFixed(3), lag: 0, dir, slice: false, tap: true });
  aim = tapAim;
});

// ---------- buttons ----------
$('btnMotion').addEventListener('click', enableMotion);
$('btnTapMode').addEventListener('click', () => { tapMode = true; startPlay(); });
$('btnCenter').addEventListener('click', () => {
  center = heading ?? 0; aim = 0; buzz(20);
  startSwingStep('gentle');
});
$('btnUseSaved').addEventListener('click', () => { center = heading ?? 0; aim = 0; startPlay(); });
$('btnRecal').addEventListener('click', () => {
  if (tapMode) { tapMode = false; stage = 'motion'; show('s-motion'); return; }
  stage = 'center'; show('s-center'); sendStatus();
});
// Reads: a hidden guess at the opponent's next shot (my_read view; revealed by read_event after the shot).
for (const b of document.querySelectorAll('#pReads button')) {
  b.addEventListener('click', () => {
    const rd = conn && first(conn.db.myRead.iter());
    act('pickRead', { guess: rd && rd.guess === b.dataset.read ? '' : b.dataset.read });
    buzz(15);
  });
}
// Secret moves: armed through a reducer, visible only to this player's devices (my_secret view).
for (const b of document.querySelectorAll('#pSecrets button')) {
  b.addEventListener('click', () => {
    const sec = conn && first(conn.db.mySecret.iter());
    act('pickSecret', { move: sec && sec.armed === b.dataset.move ? '' : b.dataset.move });
    buzz(15);
  });
}

// Test hook: lets automated tests drive the swing detector without real sensors.
window.__phone = { feed, gestureOf, onMotion, onOrientation, setAim: a => { aim = a; }, cal, get stage() { return stage; }, startPlay, startSwingStep };
