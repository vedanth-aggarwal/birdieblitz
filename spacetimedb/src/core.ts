// Shared game core: shuttle physics, shot rules, timing and the AI brain.
// The SpacetimeDB module uses it to decide every shot and landing; the laptop imports the
// exact same file to animate the flight locally, so server and screens always agree.
//
// World frame (meters): origin = court center on the ground, +Y up.
// Seat 0 plays on the +Z half, seat 1 on the −Z half.

export const G = 9.81;
export const HALF_L = 6.7;          // baseline
export const HALF_W = 2.59;         // singles sideline
export const HALF_W_DOUBLES = 3.05;
export const SHORT_LINE = 1.98;     // short service line distance from net
export const NET_H = 1.55;
export const TERMINAL_V = 6.8;      // shuttlecock terminal velocity (m/s)
export const K = G / (TERMINAL_V * TERMINAL_V); // quadratic drag coefficient
export const TIME_SCALE = 0.85;     // game time runs slightly slow for readability

export type Rng = () => number;     // uniform [0, 1)
export type Seat = 0 | 1;
export const sideOf = (seat: number) => (seat === 0 ? 1 : -1);

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// Minimal vector (field-compatible with THREE.Vector3, so the renderer can copy from it).
export class V3 {
  constructor(public x = 0, public y = 0, public z = 0) {}
  set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v: { x: number; y: number; z: number }) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  length() { return Math.hypot(this.x, this.y, this.z); }
}
type Vec = { x: number; y: number; z: number };

export function isIn(p: Vec) {
  return Math.abs(p.x) <= HALF_W + 0.02 && Math.abs(p.z) <= HALF_L + 0.02;
}

export type PhysEvent = { type: 'net' | 'land'; pos: V3; in?: boolean };

export class Shuttle {
  pos = new V3(0, -5, 0);
  prev = new V3(0, -5, 0);
  vel = new V3();
  active = false;
  landed = false;

  launch(p0: Vec, v: Vec) {
    this.pos.copy(p0); this.prev.copy(p0); this.vel.copy(v);
    this.active = true; this.landed = false;
  }

  hold(p: Vec) { this.pos.copy(p); this.prev.copy(p); this.vel.set(0, 0, 0); this.active = false; this.landed = false; }

  copyFrom(s: Shuttle) { this.pos.copy(s.pos); this.prev.copy(s.prev); this.vel.copy(s.vel); this.active = s.active; this.landed = s.landed; return this; }

  step(dt: number, events?: PhysEvent[]) {
    if (!this.active || this.landed) return;
    this.prev.copy(this.pos);
    // midpoint (RK2) integration — stable with strong drag
    const v = this.vel, sv = v.length();
    const ax0 = -K * sv * v.x, ay0 = -G - K * sv * v.y, az0 = -K * sv * v.z;
    const vmx = v.x + ax0 * dt * 0.5, vmy = v.y + ay0 * dt * 0.5, vmz = v.z + az0 * dt * 0.5;
    const s = Math.hypot(vmx, vmy, vmz);
    const ax = -K * s * vmx, ay = -G - K * s * vmy, az = -K * s * vmz;
    this.pos.x += vmx * dt; this.pos.y += vmy * dt; this.pos.z += vmz * dt;
    v.x += ax * dt; v.y += ay * dt; v.z += az * dt;

    // Net: crossing z = 0 below the tape → falls back on the hitter's side
    const pz = this.prev.z;
    if (pz !== 0 && Math.sign(pz) !== Math.sign(this.pos.z)) {
      const f = pz / (pz - this.pos.z);
      const y = this.prev.y + (this.pos.y - this.prev.y) * f;
      const x = this.prev.x + (this.pos.x - this.prev.x) * f;
      if (y < NET_H && y > 0 && Math.abs(x) < HALF_W_DOUBLES + 0.1) {
        this.pos.z = Math.sign(pz) * 0.04;
        v.set(v.x * 0.15, Math.min(v.y, 0) * 0.2, -v.z * 0.08);
        events?.push({ type: 'net', pos: this.pos.clone() });
      }
    }

    if (this.pos.y <= 0) {
      this.pos.y = 0;
      this.landed = true;
      events?.push({ type: 'land', pos: this.pos.clone(), in: isIn(this.pos) });
    }
  }
}

// ---------- prediction ----------
const _sim = new Shuttle();
const SIM_DT = 1 / 120;

// Simulate a launch; report landing point, net clearance and flight time (game seconds).
function simulateLaunch(p0: Vec, v: Vec, maxT = 6) {
  _sim.launch(p0, v);
  let netY: number | null = null, t = 0;
  while (t < maxT) {
    const pz = _sim.pos.z, py = _sim.pos.y;
    _sim.step(SIM_DT);
    t += SIM_DT;
    if (netY === null && pz !== 0 && Math.sign(pz) !== Math.sign(_sim.pos.z)) {
      const f = pz / (pz - _sim.pos.z);
      netY = py + (_sim.pos.y - py) * f;
    }
    if (_sim.landed) break;
  }
  return { land: _sim.pos.clone(), netY, time: t };
}

// Find launch velocity: fixed speed, heading toward target, scan pitch for the best landing distance.
// branch 'high' = lobbed (clear, lift), 'low' = direct (smash, drive, drop, net shot).
export function solveShot(p0: Vec, target: Vec, speed: number, branch: 'high' | 'low', netMargin = 0.12) {
  let dx = target.x - p0.x, dz = target.z - p0.z;
  const want = Math.hypot(dx, dz);
  dx /= want || 1; dz /= want || 1;
  const cands: { v: V3; dist: number; ok: boolean; time: number; land: V3 }[] = [];
  for (let deg = -55; deg <= 82; deg += 1.5) {
    const r = deg * Math.PI / 180;
    const v = new V3(dx * Math.cos(r) * speed, Math.sin(r) * speed, dz * Math.cos(r) * speed);
    const res = simulateLaunch(p0, v);
    const crossed = Math.sign(res.land.z) !== Math.sign(p0.z);
    const dist = (res.land.x - p0.x) * dx + (res.land.z - p0.z) * dz;
    cands.push({ v, dist, ok: crossed && res.netY !== null && res.netY > NET_H + netMargin, time: res.time, land: res.land });
  }
  // Split at the max-range pitch: lower pitches = low branch, higher = high branch.
  let peak = 0;
  cands.forEach((c, i) => { if (c.dist > cands[peak].dist) peak = i; });
  const pick = (list: typeof cands) => list.filter(c => c.ok).sort((a, b) => Math.abs(a.dist - want) - Math.abs(b.dist - want))[0];
  const low = cands.slice(0, peak + 1), high = cands.slice(peak);
  const best = (branch === 'high' ? pick(high) || pick(low) : pick(low) || pick(high))
    || cands.slice().sort((a, b) => Math.abs(a.dist - want) - Math.abs(b.dist - want))[0];
  return { v: best.v, time: best.time, land: best.land, ok: best.ok };
}

// Same as solveShot, but adds speed (up to ~2×) when nothing clears the net — soft shots from deep court.
export function solveShotBoosted(p0: Vec, target: Vec, speed: number, branch: 'high' | 'low', netMargin?: number) {
  let sol = solveShot(p0, target, speed, branch, netMargin);
  for (let i = 0; i < 5 && !sol.ok; i++) {
    speed *= 1.18;
    sol = solveShot(p0, target, speed, branch, netMargin);
  }
  return sol;
}

// Where/when the shuttle can be hit on `side` (+1 = +Z half, −1 = −Z half): first point on that side
// where it has come down to hitting height. Falls back to just before it lands. Times are game seconds.
export function predictContact(shuttle: Shuttle, side: number, maxHeight = 2.35) {
  _sim.copyFrom(shuttle);
  _sim.active = true;
  let t = 0;
  let last: { pos: V3; t: number } | null = null, contact: { pos: V3; t: number } | null = null;
  while (t < 6) {
    _sim.step(SIM_DT);
    t += SIM_DT;
    const p = _sim.pos;
    if (!contact && side * p.z > 0.5 && p.y <= maxHeight && (_sim.vel.y < 0 || p.y < 1.2)) contact = { pos: p.clone(), t };
    if (side * p.z > 0.3 && p.y > 0.25) last = { pos: p.clone(), t };
    if (_sim.landed) break;
  }
  return { contact: contact || last, land: _sim.pos.clone(), landT: t, landIn: isIn(_sim.pos) };
}

// Full flight from a launch: where it lands and when (game seconds).
export function flightOf(p0: Vec, v: Vec) {
  const s = new Shuttle(); s.launch(p0, v);
  let t = 0;
  while (t < 8 && !s.landed) { s.step(SIM_DT); t += SIM_DT; }
  return { land: s.pos.clone(), landT: t, landIn: isIn(s.pos) };
}

// Where and when a launch crosses the net (game seconds), or null if it never gets over.
// Fog of war reveals the shuttle to the receiver only from this moment.
export function crossingOf(p0: Vec, v: Vec) {
  const s = new Shuttle(); s.launch(p0, v);
  const side = Math.sign(p0.z) || 1;
  let t = 0;
  while (t < 8 && !s.landed) {
    s.step(SIM_DT); t += SIM_DT;
    if (Math.sign(s.pos.z) === -side && s.pos.z !== 0) return { t, pos: s.pos.clone(), vel: s.vel.clone() };
  }
  return null;
}

// ---------- timing ----------
// Timing windows in real seconds (swing time − ideal contact time).
export const WINDOWS = { perfect: 0.07, good: 0.15, ok: 0.26 };

export function gradeTiming(dt: number) {
  const a = Math.abs(dt);
  if (a <= WINDOWS.perfect) return 'PERFECT!';
  if (a <= WINDOWS.good) return 'GOOD';
  if (a <= WINDOWS.ok) return dt < 0 ? 'EARLY' : 'LATE';
  return null;
}

// ---------- shots ----------
export type Gesture = { dir?: string; slice?: boolean };
export const SPECIALS = ['power', 'curve', 'feint'] as const;
export type Special = (typeof SPECIALS)[number] | '';

type ShotSpec = { name: string; depth: [number, number]; speed: number; branch: 'high' | 'low'; smash?: boolean };

// Shot = contact height × swing gesture × power. depth = distance past the net; speed in m/s.
// Gestures: dir 'down' (chop), 'up' (low → high), 'flat' (forward); slice = wrist twist.
// Soft shots need more pace the further they are hit from the net (drag kills a slow shuttle).
function shotType(contactY: number, power: number, fromNet: number, { dir = 'flat', slice = false }: Gesture, grade: string): ShotSpec {
  const overhead = contactY > 1.9, mid = contactY > 1.0;
  if (slice || power < 0.3) {
    if (overhead) return { name: 'DROP', depth: [1.6, 2.6], speed: 8 + fromNet * 1.6, branch: 'low' };
    if (mid) return { name: 'NET DROP', depth: [1.1, 2.0], speed: 5 + fromNet * 1.8, branch: 'low' };
    return { name: 'NET SHOT', depth: [0.6, 1.5], speed: 4 + fromNet * 2, branch: 'low' };
  }
  if (dir === 'down') {
    if (overhead) {
      // A real smash needs a hard chop, a high contact and clean timing — otherwise it's a half smash.
      const clean = grade === 'PERFECT!' || grade === 'GOOD';
      if (power >= 0.8 && contactY > 2.1 && clean) {
        const deep = fromNet > 4.5 ? 4 : 0; // smashing from the back court loses pace
        return { name: 'SMASH!', depth: [3.6, 5.4], speed: 26 + power * 4 - deep, branch: 'low', smash: true };
      }
      return { name: 'HALF SMASH', depth: [3.0, 4.8], speed: 18 + power * 3, branch: 'low' };
    }
    if (mid) return { name: 'PUSH', depth: [3.0, 4.6], speed: 14 + power * 4, branch: 'low' };
    return { name: 'NET SHOT', depth: [0.6, 1.5], speed: 4 + fromNet * 2, branch: 'low' };
  }
  if (dir === 'up') {
    if (overhead) return { name: 'CLEAR', depth: [5.4, 6.3], speed: 21, branch: 'high' };
    return { name: 'LIFT', depth: [5.4, 6.3], speed: 17 + power * 3, branch: 'high' };
  }
  if (overhead) return { name: 'CLEAR', depth: [5.4, 6.3], speed: 20 + power * 2, branch: 'high' };
  if (mid) return { name: 'DRIVE', depth: [4.4, 6.0], speed: 16 + power * 6, branch: 'low' };
  return { name: 'LIFT', depth: [5.4, 6.3], speed: 17 + power * 3, branch: 'high' };
}

// side: +1 = hitter on the +Z half, hitting toward −Z. `aim` is in world X (−1…1).
// Specials (secret moves): power = extra pace, curve = bends out toward the sideline,
// feint = a drop disguised as a clear (the opponent's screen announces the fake name).
export function makeShot(o: { from: Vec; side: number; power: number; aim: number; grade: string; gesture?: Gesture; special?: Special; rng: Rng }) {
  const { from, side, power, aim, grade, rng } = o;
  const rand = (a: number, b: number) => a + rng() * (b - a);
  let s = shotType(from.y, power, Math.abs(from.z), o.gesture || {}, grade);
  let shown = s.name;
  if (o.special === 'feint') {
    const real = shotType(from.y, 0.2, Math.abs(from.z), { slice: true }, grade);
    shown = s.smash || from.y > 1.9 ? 'CLEAR' : 'DRIVE';
    s = real;
  }
  const errs: Record<string, number> = { 'PERFECT!': 0, GOOD: 0.25, EARLY: 0.7, LATE: 0.7 };
  const err = errs[grade] ?? 0.5;
  const depth = rand(s.depth[0], s.depth[1]) + rand(-err, err) * 0.8;
  let x = clamp(aim, -1, 1) * (HALF_W - 0.35) + rand(-err, err);
  if (grade === 'EARLY') x -= side * 0.45; // early = pulled across, late = pushed wide
  if (grade === 'LATE') x += side * 0.45;
  if (o.special === 'curve') x = clamp(x + (x >= 0 ? 1 : -1) * 1.1, -HALF_W + 0.15, HALF_W - 0.15);
  const target = new V3(x, 0, -side * clamp(depth, 0.4, HALF_L + 1));
  let speed = s.speed * (grade === 'PERFECT!' ? 1.08 : grade === 'GOOD' ? 1 : 0.88);
  if (o.special === 'power') speed *= 1.18;
  const netMargin = grade === 'PERFECT!' ? 0.18 : grade === 'GOOD' ? 0.1 : -0.02;
  const sol = solveShotBoosted(from, target, speed, s.branch, netMargin);
  return { name: s.name, shown, smash: !!s.smash, v: sol.v, target, speed };
}

// ---------- serving ----------
// Even score → serve from the right court (each player's own right).
export function serveSpots(serverSeat: number, serverScore: number) {
  const ss = sideOf(serverSeat), right = serverScore % 2 === 0;
  const sx = right ? 0.8 : -0.8;
  return {
    server: new V3(sx * ss, 0, ss * 2.7),
    receiver: new V3(-sx * ss, 0, -ss * 3.5),
    hold: new V3(sx * ss + ss * 0.5, 0.95, ss * 2.7 - ss * 0.45),
  };
}

// Gentle = short serve just past the short line, harder = long high serve. Diagonal like real badminton.
export function makeServe(o: { from: Vec; side: number; power: number; aim: number; rng: Rng }) {
  const { from, side, power, aim, rng } = o;
  const rand = (a: number, b: number) => a + rng() * (b - a);
  const long = power >= 0.35;
  const diagX = -Math.sign(from.x || 0.5) * rand(0.6, 1.6) + aim * 0.5;
  const depth = long ? rand(5.6, 6.4) : SHORT_LINE + rand(0.15, 0.6);
  const target = new V3(clamp(diagX, -HALF_W + 0.3, HALF_W - 0.3), 0, -side * depth);
  const sol = solveShotBoosted(from, target, long ? 19 : 5 + Math.abs(from.z) * 1.4, long ? 'high' : 'low', 0.15);
  return { name: long ? 'LONG SERVE' : 'SHORT SERVE', v: sol.v, target };
}

// ---------- AI ----------
export const LEVELS = [
  { name: 'EASY',   run: 4.2, react: 0.35, timing: 0.13, smash: 0.1,  aim: 0.55, letOut: 0.3,  drop: 0.25, secret: 0.1 },
  { name: 'NORMAL', run: 5.0, react: 0.25, timing: 0.09, smash: 0.22, aim: 0.8,  letOut: 0.6,  drop: 0.3,  secret: 0.2 },
  { name: 'PRO',    run: 5.8, react: 0.16, timing: 0.055, smash: 0.4, aim: 1.0,  letOut: 0.85, drop: 0.35, secret: 0.35 },
];

// Decide how the AI plays an incoming shuttle.
// Returns null to let it go (it's going out), or the swing it will make.
export function aiDecide(level: number, o: { contactY: number; landIn: boolean; opponentX: number; rng: Rng }) {
  const L = LEVELS[level] ?? LEVELS[1];
  const rng = o.rng;
  if (!o.landIn && rng() < L.letOut) return null;

  let power: number, gesture: Gesture = { dir: 'flat' };
  const r = rng();
  if (o.contactY > 2.1) {
    if (r < L.smash) { power = 0.9; gesture = { dir: 'down' }; }
    else if (r < L.smash + L.drop) { power = 0.5; gesture = { slice: true }; }
    else if (r < L.smash + L.drop + 0.15) { power = 0.6; gesture = { dir: 'down' }; } // half smash
    else power = 0.55;
  } else if (o.contactY > 1.0) power = r < 0.3 ? 0.2 : 0.6;
  else power = r < 0.35 ? 0.2 : 0.6;

  // Aim for the open court: away from where the opponent is standing (world X).
  const away = o.opponentX > 0.3 ? -1 : o.opponentX < -0.3 ? 1 : (rng() < 0.5 ? -1 : 1);
  const aim = away * (0.4 + rng() * 0.6) * L.aim;

  const gauss = () => (rng() + rng() + rng() - 1.5) * 1.15;
  let timingError = gauss() * L.timing;
  let grade = gradeTiming(timingError);
  if (!grade) { timingError = Math.sign(timingError) * 0.2; grade = timingError < 0 ? 'EARLY' : 'LATE'; }
  return { power, gesture, aim, timingError, grade };
}
