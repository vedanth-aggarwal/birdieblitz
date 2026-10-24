// BIRDIE BLITZ — phone-swung badminton where SpacetimeDB is the referee.
// Laptops and phones are just clients: reducers decide every shot (server-side physics from core.ts),
// one-shot schedule tables resolve landings and drive the AI, lifecycle reducers pause a match when a
// device drops, and event tables carry swings, hits and rally results without storing them.
// Hidden information lives in private tables and reaches clients only through per-identity views:
// secret moves, exact stamina, your shot reads, your target zone, your scouting report, the
// opponent's real shots (sealed until the match ends) — and, during fog of war, the shuttle itself:
// the opponent's shot is withheld from your client until a scheduled reducer reveals it at the net.
import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import {
  LEVELS, SPECIALS, TIME_SCALE, Shuttle, aiDecide, flightOf, makeServe, makeShot, predictContact,
  serveSpots, sideOf, gradeTiming, crossingOf, HALF_L, type Gesture, type Special,
} from './core';

// ───────────────────────── public tables ─────────────────────────

// Every connected laptop or phone. Phones are paired to one seat of one match.
const device = table(
  { name: 'device', public: true },
  {
    identity: t.identity().primaryKey(),
    kind: t.string(),            // laptop | phone
    name: t.string(),
    matchId: t.u32().index('btree'), // 0 = not in a match
    seat: t.u8(),                // 0 | 1, 255 = none
    online: t.bool(),
    ready: t.bool(),             // phone: calibrated and swinging
    tapMode: t.bool(),
  }
);

const match = table(
  { name: 'match', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    code: t.string().unique(),
    mode: t.string(),            // ai | pvp
    level: t.u8(),
    status: t.string(),          // lobby | countdown | playing | paused | over
    phase: t.string(),           // serve | rally | point
    pausedReason: t.string(),
    scoreA: t.u32(),
    scoreB: t.u32(),
    server: t.u8(),
    target: t.u32(),
    laptopA: t.string(),         // identity hex, "AI" for the computer
    laptopB: t.string(),
    nameA: t.string(),
    nameB: t.string(),
    phoneA: t.string(),
    phoneB: t.string(),
    readyA: t.bool(),
    readyB: t.bool(),
    pointNo: t.u32(),
    rally: t.u32(),              // hits so far in the current rally
    longestRally: t.u32(),
    shotSeq: t.u32(),            // bumps on every launch; stale timers and late swings are ignored
    winner: t.u8(),              // 255 until the match is over
    startsAt: t.u64(),           // countdown end (micros)
    createdAt: t.timestamp(),
    gameNo: t.u32(),             // bumps on every start/rematch; history rows keep theirs
    fogEnabled: t.bool(),        // lobby toggle: fog of war may roll in during the match
    fogLeft: t.u8(),             // rallies of fog remaining (0 = clear)
  }
);

// The shuttle in the air — the server's truth, one row per match. PRIVATE: clients never read it
// directly. The hitter gets their own shot through the my_shot view; everyone else gets shot_feed,
// which in fog is only written once the shuttle crosses the net.
const shot = table(
  { name: 'shot' },
  {
    matchId: t.u32().primaryKey(),
    seq: t.u32(),
    hitter: t.u8(),
    px: t.f64(), py: t.f64(), pz: t.f64(),
    vx: t.f64(), vy: t.f64(), vz: t.f64(),
    shown: t.string(),           // the name the opponent sees (a feint lies here)
    smash: t.bool(),
    landX: t.f64(), landZ: t.f64(),
    landIn: t.bool(),
    launchedAt: t.u64(),
    fogged: t.bool(),
  }
);

// What the world may see of the shuttle. Clear weather: written at launch. Fog: written by the
// `cross` timer at the net, with the shuttle's state at that moment (fromNet).
const shotFeed = table(
  { name: 'shot_feed', public: true },
  {
    matchId: t.u32().primaryKey(),
    seq: t.u32(),
    hitter: t.u8(),
    px: t.f64(), py: t.f64(), pz: t.f64(),
    vx: t.f64(), vy: t.f64(), vz: t.f64(),
    shown: t.string(),
    smash: t.bool(),
    landX: t.f64(), landZ: t.f64(),
    landIn: t.bool(),
    fromNet: t.bool(),
  }
);

// Every hit ever played: powers instant replay, match stats, scouting and live SQL.
// Private: clients read it through the match_log view, which seals the opponent's real shots
// (feints, secret moves) until the match is over.
const shotLog = table(
  { name: 'shot_log' },
  {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u32().index('btree'),
    gameNo: t.u32(),
    pointNo: t.u32(),
    seq: t.u32(),
    seat: t.u8(),
    name: t.string(),            // what really happened
    shown: t.string(),
    special: t.string(),
    grade: t.string(),
    gesture: t.string(),
    power: t.f32(),
    speedKmh: t.f32(),
    px: t.f64(), py: t.f64(), pz: t.f64(),
    vx: t.f64(), vy: t.f64(), vz: t.f64(),
    at: t.timestamp(),
  }
);

const hallOfFame = table(
  { name: 'hall_of_fame', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    winner: t.string(),
    loser: t.string(),
    score: t.string(),
    mode: t.string(),
    fastestSmashKmh: t.f32(),
    longestRally: t.u32(),
    at: t.timestamp(),
  }
);

// Players waiting for a random opponent.
const queue = table(
  { name: 'queue', public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    joinedAt: t.timestamp(),
  }
);

// ───────────────────────── private tables (server-only truth) ─────────────────────────

// Secret moves: which one is armed and which are spent. Only the owner's devices see it (view below).
const secret = table(
  { name: 'secret' },
  {
    id: t.u32().primaryKey().autoInc(),
    matchId: t.u32().index('btree'),
    seat: t.u8(),
    armed: t.string(),
    usedPower: t.bool(),
    usedCurve: t.bool(),
    usedFeint: t.bool(),
    scouted: t.bool(),           // spent the once-per-match scouting report
  }
);

// Exact stamina is hidden; opponents only get a coarse label through the condition view.
const stamina = table(
  { name: 'stamina' },
  {
    id: t.u32().primaryKey().autoInc(),
    matchId: t.u32().index('btree'),
    seat: t.u8(),
    value: t.i32(),
  }
);

// Pre-match choices each player makes in the lobby, hidden from the opponent (e.g. scouting).
const loadout = table(
  { name: 'loadout' },
  {
    id: t.u32().primaryKey().autoInc(),
    matchId: t.u32().index('btree'),
    seat: t.u8(),
    scout: t.bool(),
  }
);

// Reads: before the opponent hits, guess their shot (drop / clear / smash). Hidden until it resolves.
const readPick = table(
  { name: 'read_pick' },
  {
    id: t.u32().primaryKey().autoInc(),
    matchId: t.u32().index('btree'),
    seat: t.u8(),
    guess: t.string(),           // '' | drop | clear | smash
    seq: t.u32(),                // the shot the guess is about
    buff: t.bool(),              // a correct read sharpens your next swing
  }
);

// Each player's secret bonus zone on the opponent's court, re-drawn every point.
const targetZone = table(
  { name: 'target_zone' },
  {
    id: t.u32().primaryKey().autoInc(),
    matchId: t.u32().index('btree'),
    seat: t.u8(),
    x: t.f64(),
    z: t.f64(),
    r: t.f64(),
  }
);

// How every point ended — the raw material for scouting reports.
const pointLog = table(
  { name: 'point_log' },
  {
    id: t.u32().primaryKey().autoInc(),
    matchId: t.u32().index('btree'),
    gameNo: t.u32(),
    pointNo: t.u32(),
    winner: t.u8(),
    reason: t.string(),
    lastHitter: t.u8(),
    lastShot: t.string(),
    landX: t.f64(),
    landZ: t.f64(),
    rally: t.u32(),
    bullseye: t.bool(),
  }
);

// ───────────────────────── event tables (broadcast, never stored) ─────────────────────────

// Phone → its laptop: a detected swing.
const swingEvent = table(
  { name: 'swing_event', public: true, event: true },
  { matchId: t.u32(), seat: t.u8(), power: t.f32(), aim: t.f32(), dir: t.string(), slice: t.bool(), lag: t.u32(), tap: t.bool() }
);

// Phone → its laptop: live racket aim (throttled on the phone).
const aimEvent = table(
  { name: 'aim_event', public: true, event: true },
  { matchId: t.u32(), seat: t.u8(), aim: t.f32(), pitch: t.f32() }
);

// Server → everyone in the match: a hit happened (callouts, sound, phone vibration).
const hitEvent = table(
  { name: 'hit_event', public: true, event: true },
  { matchId: t.u32(), seat: t.u8(), shown: t.string(), grade: t.string(), smash: t.bool(), speedKmh: t.f32() }
);

// Server → everyone in the match: a rally ended (bullseye = landed in the winner's secret zone).
const rallyEvent = table(
  { name: 'rally_event', public: true, event: true },
  { matchId: t.u32(), winner: t.u8(), reason: t.string(), scoreA: t.u32(), scoreB: t.u32(), rally: t.u32(), bullseye: t.bool() }
);

// Server → everyone in the match: a read was revealed, after the shot it was about.
const readEvent = table(
  { name: 'read_event', public: true, event: true },
  { matchId: t.u32(), seat: t.u8(), guess: t.string(), actual: t.string(), correct: t.bool() }
);

// Server → everyone in the match: short status toasts.
const noticeEvent = table(
  { name: 'notice_event', public: true, event: true },
  { matchId: t.u32(), text: t.string() }
);

// ───────────────────────── schedule table ─────────────────────────

// One-shot timers: start, serve_ready, land, ai_hit, ai_serve, idle_serve
const timer = table(
  { name: 'timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    matchId: t.u32().index('btree'),
    kind: t.string(),
    seq: t.u32(),
    arg: t.string(),
  }
);

const spacetimedb = schema({
  device, match, shotFeed, hallOfFame, queue,
  shot, shotLog, secret, stamina, readPick, targetZone, pointLog, loadout,
  swingEvent, aimEvent, hitEvent, rallyEvent, readEvent, noticeEvent,
  timer,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type MatchRow = NonNullable<ReturnType<Ctx['db']['match']['id']['find']>>;
type DeviceRow = NonNullable<ReturnType<Ctx['db']['device']['identity']['find']>>;

// ───────────────────────── helpers ─────────────────────────

const now = (ctx: Ctx) => ctx.timestamp.microsSinceUnixEpoch;
const ms = (n: number) => BigInt(Math.round(n)) * 1000n;
const rngOf = (ctx: Ctx) => () => ctx.random.integerInRange(0, 999_999) / 1_000_000;
const hex = (ctx: Ctx) => ctx.sender.toHexString();
const other = (seat: number) => (seat === 0 ? 1 : 0);
const NONE = 255;
const GRACE_MS = 220;            // receivers see the shuttle a network hop late; give them that back
const POINTS_TO_WIN = 5;         // win by 2, capped at POINTS_TO_WIN + 2
const POINT_PAUSE_MS = 3200;     // time to take in the point before the next serve
const FOG_CHANCE = 0.3;          // per point, once fog is allowed and the air is clear

function schedule(ctx: Ctx, matchId: number, kind: string, delayMs: number, seq = 0, arg = '') {
  ctx.db.timer.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(now(ctx) + ms(delayMs)), matchId, kind, seq, arg });
}

function notice(ctx: Ctx, matchId: number, text: string) {
  ctx.db.noticeEvent.insert({ matchId, text });
}

function cleanName(name: string) {
  const n = name.trim().replace(/\s+/g, ' ').slice(0, 16);
  return n || 'Player';
}

function upsertDevice(ctx: Ctx, patch: Partial<DeviceRow>): DeviceRow {
  const cur = ctx.db.device.identity.find(ctx.sender);
  if (cur) {
    const next = { ...cur, ...patch, online: true };
    ctx.db.device.identity.update(next);
    return next;
  }
  const row: DeviceRow = { identity: ctx.sender, kind: 'laptop', name: 'Player', matchId: 0, seat: NONE, online: true, ready: false, tapMode: false, ...patch };
  ctx.db.device.insert(row);
  return row;
}

const seatLaptop = (m: MatchRow, seat: number) => (seat === 0 ? m.laptopA : m.laptopB);
const seatPhone = (m: MatchRow, seat: number) => (seat === 0 ? m.phoneA : m.phoneB);
const seatName = (m: MatchRow, seat: number) => (seat === 0 ? m.nameA : m.nameB);
const isAI = (m: MatchRow, seat: number) => seatLaptop(m, seat) === 'AI';

/** The caller's laptop seat in its current match. */
function myLaptopSeat(ctx: Ctx): { m: MatchRow; seat: number } {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0) throw new SenderError('You are not in a match');
  const m = ctx.db.match.id.find(d.matchId);
  if (!m) throw new SenderError('Match not found');
  const me = hex(ctx);
  const seat = m.laptopA === me ? 0 : m.laptopB === me ? 1 : -1;
  if (seat < 0) throw new SenderError('Only a laptop in this match can do that');
  return { m, seat };
}

/** Caller's seat whether it is the laptop or the paired phone. */
function myAnySeat(ctx: Ctx): { m: MatchRow; seat: number } {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0 || d.seat === NONE) throw new SenderError('Not in a match');
  const m = ctx.db.match.id.find(d.matchId);
  if (!m) throw new SenderError('Match not found');
  return { m, seat: d.seat };
}

function newCode(ctx: Ctx) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[ctx.random.integerInRange(0, chars.length - 1)];
  } while (ctx.db.match.code.find(code));
  return code;
}

function seatRow<T extends { seat: number }>(rows: Iterable<T>, seat: number) {
  for (const r of rows) if (r.seat === seat) return r;
  return undefined;
}
const secretOf = (ctx: Ctx, matchId: number, seat: number) => seatRow(ctx.db.secret.matchId.filter(matchId), seat);
const staminaOf = (ctx: Ctx, matchId: number, seat: number) => seatRow(ctx.db.stamina.matchId.filter(matchId), seat);
const readOf = (ctx: Ctx, matchId: number, seat: number) => seatRow(ctx.db.readPick.matchId.filter(matchId), seat);
const zoneOf = (ctx: Ctx, matchId: number, seat: number) => seatRow(ctx.db.targetZone.matchId.filter(matchId), seat);

const READS = ['drop', 'clear', 'smash'];
/** The family a shot belongs to, for reads: attacking, soft/short, or high/deep. */
function categoryOf(name: string) {
  if (name === 'SMASH!' || name === 'HALF SMASH' || name === 'PUSH' || name === 'DRIVE') return 'smash';
  if (name === 'CLEAR' || name === 'LIFT' || name === 'LONG SERVE') return 'clear';
  return 'drop';
}
const UPGRADE: Record<string, string> = { EARLY: 'GOOD', LATE: 'GOOD', GOOD: 'PERFECT!', 'PERFECT!': 'PERFECT!' };

function addStamina(ctx: Ctx, matchId: number, seat: number, delta: number) {
  const st = staminaOf(ctx, matchId, seat);
  if (st) ctx.db.stamina.id.update({ ...st, value: Math.max(0, Math.min(100, st.value + delta)) });
}

/** New secret bonus zones for both players: somewhere on the opponent's half. */
function drawZones(ctx: Ctx, m: MatchRow) {
  const rnd = rngOf(ctx);
  for (const seat of [0, 1]) {
    const z = { x: (rnd() * 2 - 1) * 1.9, z: -sideOf(seat) * (1.6 + rnd() * 4.0), r: 1.0 };
    const cur = zoneOf(ctx, m.id, seat);
    if (cur) ctx.db.targetZone.id.update({ ...cur, ...z });
    else ctx.db.targetZone.insert({ id: 0, matchId: m.id, seat, ...z });
  }
}

function blankMatch(ctx: Ctx, mode: string, level: number): MatchRow {
  return {
    id: 0, code: newCode(ctx), mode, level, status: 'lobby', phase: '', pausedReason: '',
    scoreA: 0, scoreB: 0, server: 0, target: POINTS_TO_WIN,
    laptopA: '', laptopB: '', nameA: '', nameB: '', phoneA: '', phoneB: '',
    readyA: false, readyB: false, pointNo: 0, rally: 0, longestRally: 0, shotSeq: 0,
    winner: NONE, startsAt: 0n, createdAt: ctx.timestamp, gameNo: 0, fogEnabled: mode === 'pvp', fogLeft: 0,
  };
}

/** Leaving mid-match forfeits it; a waiting lobby is simply closed. */
function leaveCurrent(ctx: Ctx) {
  ctx.db.queue.identity.delete(ctx.sender);
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0) return;
  const m = ctx.db.match.id.find(d.matchId);
  ctx.db.device.identity.update({ ...d, matchId: 0, seat: NONE });
  if (!m || d.kind !== 'laptop') return;
  const me = hex(ctx);
  const seat = m.laptopA === me ? 0 : m.laptopB === me ? 1 : -1;
  if (seat < 0) return;
  if (m.status === 'over') return;
  const opp = seatLaptop(m, other(seat));
  if (opp && opp !== 'AI' && m.status !== 'lobby') {
    finishMatch(ctx, { ...m }, other(seat), `${seatName(m, seat)} left the match`);
  } else if (m.status === 'lobby' && seat === 1) {
    ctx.db.match.id.update({ ...m, laptopB: '', nameB: '', phoneB: '', readyB: false });
  } else {
    ctx.db.match.id.update({ ...m, status: 'over', phase: '', winner: other(seat) });
  }
}

// ───────────────────────── shot engine ─────────────────────────

const shuttleFromShot = (s: { px: number; py: number; pz: number; vx: number; vy: number; vz: number }) => {
  const sh = new Shuttle();
  sh.launch({ x: s.px, y: s.py, z: s.pz }, { x: s.vx, y: s.vy, z: s.vz });
  return sh;
};

/** Put a new shuttle in the air: shot row for screens, landing timer, AI reaction if the AI receives. */
function launch(
  ctx: Ctx, m: MatchRow, hitter: number,
  from: { x: number; y: number; z: number }, v: { x: number; y: number; z: number },
  info: { name: string; shown: string; smash: boolean; special: string; grade: string; gesture: string; power: number }
): MatchRow {
  const seq = m.shotSeq + 1;
  const fl = flightOf(from, v);
  const fogged = m.fogLeft > 0;
  const row = {
    matchId: m.id, seq, hitter, px: from.x, py: from.y, pz: from.z, vx: v.x, vy: v.y, vz: v.z,
    shown: info.shown, smash: info.smash, landX: fl.land.x, landZ: fl.land.z, landIn: fl.landIn, launchedAt: now(ctx), fogged,
  };
  if (ctx.db.shot.matchId.find(m.id)) ctx.db.shot.matchId.update(row); else ctx.db.shot.insert(row);
  if (!fogged) publishShot(ctx, row, row, false);
  else {
    // Fog: nobody but the hitter learns about this shot until it crosses the net.
    const cross = crossingOf(from, v);
    if (cross) schedule(ctx, m.id, 'cross', (cross.t / TIME_SCALE) * 1000, seq);
  }

  resolveRead(ctx, m, hitter, info.name);
  const speedKmh = Math.hypot(v.x, v.y, v.z) * 3.6;
  ctx.db.shotLog.insert({
    id: 0n, matchId: m.id, gameNo: m.gameNo, pointNo: m.pointNo, seq, seat: hitter, name: info.name, shown: info.shown, special: info.special,
    grade: info.grade, gesture: info.gesture, power: info.power, speedKmh,
    px: from.x, py: from.y, pz: from.z, vx: v.x, vy: v.y, vz: v.z, at: ctx.timestamp,
  });
  ctx.db.hitEvent.insert({ matchId: m.id, seat: hitter, shown: info.shown, grade: info.grade, smash: info.smash, speedKmh });

  const next = { ...m, shotSeq: seq, phase: 'rally', rally: m.rally + 1 };
  ctx.db.match.id.update(next);
  schedule(ctx, m.id, 'land', (fl.landT / TIME_SCALE) * 1000 + GRACE_MS, seq);

  const recv = other(hitter);
  if (isAI(next, recv)) planAI(ctx, next, recv, row);
  return next;
}

function publishShot(ctx: Ctx, s: ShotRow, at: { px: number; py: number; pz: number; vx: number; vy: number; vz: number }, fromNet: boolean) {
  const row = {
    matchId: s.matchId, seq: s.seq, hitter: s.hitter, px: at.px, py: at.py, pz: at.pz, vx: at.vx, vy: at.vy, vz: at.vz,
    shown: s.shown, smash: s.smash, landX: s.landX, landZ: s.landZ, landIn: s.landIn, fromNet,
  };
  if (ctx.db.shotFeed.matchId.find(s.matchId)) ctx.db.shotFeed.matchId.update(row); else ctx.db.shotFeed.insert(row);
}

/** The receiver's hidden guess about this shot is checked against what was really played (a feint can't fool a drop read). */
function resolveRead(ctx: Ctx, m: MatchRow, hitter: number, realName: string) {
  const reader = other(hitter);
  const actual = categoryOf(realName);
  const rd = readOf(ctx, m.id, reader);
  if (!rd) return;
  if (isAI(m, reader)) {
    // The CPU reads too, at its secret-move rate, and is right about half the time.
    const L = LEVELS[m.level] ?? LEVELS[1];
    const rnd = rngOf(ctx);
    if (rnd() >= L.secret) return;
    const correct = rnd() < 0.5;
    const guess = correct ? actual : READS.filter(r => r !== actual)[ctx.random.integerInRange(0, 1)];
    ctx.db.readPick.id.update({ ...rd, guess: '', buff: rd.buff || correct });
    ctx.db.readEvent.insert({ matchId: m.id, seat: reader, guess, actual, correct });
    return;
  }
  if (!rd.guess || rd.seq !== m.shotSeq) return;
  const correct = rd.guess === actual;
  ctx.db.readPick.id.update({ ...rd, guess: '', buff: rd.buff || correct });
  if (!correct) addStamina(ctx, m.id, reader, -5);
  ctx.db.readEvent.insert({ matchId: m.id, seat: reader, guess: rd.guess, actual, correct });
}

/** The AI is a scheduled reducer: decide now, swing when the shuttle arrives (plus its timing error). */
function planAI(ctx: Ctx, m: MatchRow, seat: number, s: { px: number; py: number; pz: number; vx: number; vy: number; vz: number }) {
  const L = LEVELS[m.level] ?? LEVELS[1];
  const pred = predictContact(shuttleFromShot(s), sideOf(seat));
  if (!pred.contact) return;
  const home = { x: 0, z: sideOf(seat) * 3.7 };
  const reach = Math.max(0, Math.hypot(pred.contact.pos.x - home.x, pred.contact.pos.z - home.z) - 1.2);
  const need = reach / L.run + L.react;
  const have = pred.contact.t / TIME_SCALE;
  if (need > have + 0.2) return; // can't get there
  const d = aiDecide(m.level, { contactY: pred.contact.pos.y, landIn: pred.landIn, opponentX: s.px, rng: rngOf(ctx) });
  if (!d) return; // letting it go out
  const zone = zoneOf(ctx, m.id, seat);
  if (zone && rngOf(ctx)() < 0.5) d.aim = Math.max(-1, Math.min(1, zone.x / 2.24)); // go for its secret zone
  if (rngOf(ctx)() < L.secret) {
    const sec = secretOf(ctx, m.id, seat);
    const free = SPECIALS.filter(sp => sec && !sec[sp === 'power' ? 'usedPower' : sp === 'curve' ? 'usedCurve' : 'usedFeint']);
    if (sec && !sec.armed && free.length) ctx.db.secret.id.update({ ...sec, armed: free[ctx.random.integerInRange(0, free.length - 1)] });
  }
  schedule(ctx, m.id, 'ai_hit', (have + d.timingError) * 1000, m.shotSeq, JSON.stringify(d));
}

/** A hit by `seat` on the shuttle that is coming to it. The server picks the contact point and the shot. */
function hit(ctx: Ctx, m: MatchRow, seat: number, power: number, aim: number, grade: string, gesture: Gesture) {
  const s = ctx.db.shot.matchId.find(m.id);
  if (!s) return;
  const pred = predictContact(shuttleFromShot(s), sideOf(seat));
  if (!pred.contact) return;
  const from = pred.contact.pos;
  from.y = Math.max(from.y, 0.2);

  // Stamina: hard swings tire you; below 30 you can't swing at full power.
  const st = staminaOf(ctx, m.id, seat);
  if (st) {
    if (st.value < 30) power = Math.min(power, 0.7);
    const cost = power > 0.8 || gesture.dir === 'down' ? 12 : 5;
    ctx.db.stamina.id.update({ ...st, value: Math.max(0, st.value - cost) });
  }

  // A correct read earlier in the rally sharpens this swing by one timing grade.
  const rd = readOf(ctx, m.id, seat);
  if (rd && rd.buff) {
    grade = UPGRADE[grade] ?? grade;
    ctx.db.readPick.id.update({ ...rd, buff: false });
  }

  // Secret move: consumed on this hit, revealed only by its effect (and the replay).
  let special: Special = '';
  const sec = secretOf(ctx, m.id, seat);
  if (sec && sec.armed) {
    special = sec.armed as Special;
    ctx.db.secret.id.update({
      ...sec, armed: '',
      usedPower: sec.usedPower || special === 'power',
      usedCurve: sec.usedCurve || special === 'curve',
      usedFeint: sec.usedFeint || special === 'feint',
    });
  }

  const shotOut = makeShot({ from, side: sideOf(seat), power, aim, grade, gesture, special, rng: rngOf(ctx) });
  const gestureName = gesture.slice ? 'twist' : gesture.dir || 'flat';
  launch(ctx, m, seat, from, shotOut.v, {
    name: shotOut.name, shown: shotOut.shown, smash: shotOut.smash, special, grade, gesture: gestureName, power,
  });
}

function serveFor(ctx: Ctx, m: MatchRow, power: number, aim: number) {
  const seat = m.server;
  const spots = serveSpots(seat, seat === 0 ? m.scoreA : m.scoreB);
  const sv = makeServe({ from: spots.hold, side: sideOf(seat), power, aim, rng: rngOf(ctx) });
  launch(ctx, { ...m, rally: 0 }, seat, spots.hold, sv.v, {
    name: sv.name, shown: sv.name, smash: false, special: '', grade: '', gesture: power < 0.35 ? 'short' : 'long', power,
  });
}

type ShotRow = NonNullable<ReturnType<Ctx['db']['shot']['matchId']['find']>>;

function endRally(ctx: Ctx, m: MatchRow, winner: number, reason: string, s: ShotRow) {
  // Bullseye: a winner that lands inside the hitter's secret zone restores stamina.
  const zone = zoneOf(ctx, m.id, winner);
  const bullseye = reason === 'WINNER!' && s.hitter === winner && !!zone && Math.hypot(s.landX - zone.x, s.landZ - zone.z) <= zone.r;
  if (bullseye) addStamina(ctx, m.id, winner, 25);
  const last = [...ctx.db.shotLog.matchId.filter(m.id)].find(l => l.gameNo === m.gameNo && l.seq === s.seq);
  ctx.db.pointLog.insert({
    id: 0, matchId: m.id, gameNo: m.gameNo, pointNo: m.pointNo, winner, reason, lastHitter: s.hitter, lastShot: last?.name ?? s.shown,
    landX: s.landX, landZ: s.landZ, rally: m.rally, bullseye,
  });
  const scoreA = m.scoreA + (winner === 0 ? 1 : 0), scoreB = m.scoreB + (winner === 1 ? 1 : 0);
  let next: MatchRow = {
    ...m, scoreA, scoreB, server: winner, phase: 'point', pointNo: m.pointNo + 1,
    longestRally: Math.max(m.longestRally, m.rally), rally: 0, shotSeq: m.shotSeq + 1,
    fogLeft: m.fogLeft > 0 ? m.fogLeft - 1 : 0,
  };
  if (m.fogLeft === 1) notice(ctx, m.id, '🌤 The fog lifts');
  ctx.db.rallyEvent.insert({ matchId: m.id, winner, reason, scoreA, scoreB, rally: m.rally, bullseye });
  for (const st of [...ctx.db.stamina.matchId.filter(m.id)]) ctx.db.stamina.id.update({ ...st, value: Math.min(100, st.value + 20) });

  const hi = Math.max(scoreA, scoreB), diff = Math.abs(scoreA - scoreB);
  if ((hi >= next.target && diff >= 2) || hi >= next.target + 2) {
    finishMatch(ctx, next, scoreA > scoreB ? 0 : 1, '');
    return;
  }
  ctx.db.match.id.update(next);
  schedule(ctx, m.id, 'serve_ready', POINT_PAUSE_MS, next.pointNo);
}

function finishMatch(ctx: Ctx, m: MatchRow, winner: number, why: string) {
  const next = { ...m, status: 'over', phase: '', winner, shotSeq: m.shotSeq + 1 };
  ctx.db.match.id.update(next);
  let fastest = 0;
  for (const l of ctx.db.shotLog.matchId.filter(m.id)) if (l.gameNo === m.gameNo && l.name === 'SMASH!' && l.speedKmh > fastest) fastest = l.speedKmh;
  ctx.db.hallOfFame.insert({
    id: 0, winner: seatName(m, winner), loser: seatName(m, other(winner)),
    score: winner === 0 ? `${m.scoreA}–${m.scoreB}` : `${m.scoreB}–${m.scoreA}`,
    mode: m.mode === 'ai' ? `vs CPU ${LEVELS[m.level]?.name ?? ''}` : '1v1', fastestSmashKmh: fastest, longestRally: m.longestRally, at: ctx.timestamp,
  });
  if (why) notice(ctx, m.id, why);
}

/** Pause after a disconnect or on request. The rally in flight is replayed when play resumes. */
function pauseMatch(ctx: Ctx, m: MatchRow, reason: string) {
  ctx.db.match.id.update({ ...m, status: 'paused', pausedReason: reason, phase: 'point', rally: 0, shotSeq: m.shotSeq + 1 });
  notice(ctx, m.id, `Paused — ${reason}`);
}

function resumeMatch(ctx: Ctx, m: MatchRow) {
  ctx.db.match.id.update({ ...m, status: 'playing', pausedReason: '', phase: 'point', shotSeq: m.shotSeq + 1 });
  notice(ctx, m.id, 'Resumed — replaying the point');
  schedule(ctx, m.id, 'serve_ready', 1500, m.pointNo);
}

/** Who has to be online for this match to run: both laptops, plus any phone that was paired. */
function missingDevice(ctx: Ctx, m: MatchRow): string {
  for (const seat of [0, 1]) {
    for (const id of [seatLaptop(m, seat), seatPhone(m, seat)]) {
      if (!id || id === 'AI') continue;
      const d = [...ctx.db.device.iter()].find(x => x.identity.toHexString() === id);
      if (!d || !d.online) return `${seatName(m, seat)}'s ${id === seatPhone(m, seat) ? 'phone' : 'laptop'} disconnected`;
    }
  }
  return '';
}

function startPlay(ctx: Ctx, m: MatchRow) {
  for (const r of [...ctx.db.secret.matchId.filter(m.id)]) ctx.db.secret.id.delete(r.id);
  for (const r of [...ctx.db.stamina.matchId.filter(m.id)]) ctx.db.stamina.id.delete(r.id);
  for (const r of [...ctx.db.readPick.matchId.filter(m.id)]) ctx.db.readPick.id.delete(r.id);
  for (const r of [...ctx.db.targetZone.matchId.filter(m.id)]) ctx.db.targetZone.id.delete(r.id);
  const lo = [...ctx.db.loadout.matchId.filter(m.id)];
  for (const seat of [0, 1]) {
    const scouted = !!lo.find(l => l.seat === seat)?.scout;
    ctx.db.secret.insert({ id: 0, matchId: m.id, seat, armed: '', usedPower: false, usedCurve: false, usedFeint: false, scouted });
    ctx.db.stamina.insert({ id: 0, matchId: m.id, seat, value: 100 });
    ctx.db.readPick.insert({ id: 0, matchId: m.id, seat, guess: '', seq: 0, buff: false });
  }
  const next = { ...m, status: 'playing', phase: 'point', scoreA: 0, scoreB: 0, server: 0, pointNo: 0, rally: 0, longestRally: 0, winner: NONE, gameNo: m.gameNo + 1, fogLeft: 0 };
  ctx.db.match.id.update(next);
  schedule(ctx, m.id, 'serve_ready', 300, 0);
}

// ───────────────────────── lifecycle ─────────────────────────

export const init = spacetimedb.init(_ctx => {});

export const onConnect = spacetimedb.clientConnected(ctx => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d) return;
  ctx.db.device.identity.update({ ...d, online: true });
  if (d.matchId === 0) return;
  const m = ctx.db.match.id.find(d.matchId);
  if (m && m.status === 'paused' && m.pausedReason.includes('disconnected') && !missingDevice(ctx, m)) resumeMatch(ctx, m);
  else if (m) notice(ctx, m.id, `${d.kind === 'phone' ? 'Phone' : seatName(m, d.seat)} reconnected`);
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  ctx.db.queue.identity.delete(ctx.sender);
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d) return;
  ctx.db.device.identity.update({ ...d, online: false });
  if (d.matchId === 0) return;
  const m = ctx.db.match.id.find(d.matchId);
  if (!m || (m.status !== 'playing' && m.status !== 'countdown')) return;
  const me = d.identity.toHexString();
  const needed = [m.laptopA, m.laptopB, m.phoneA, m.phoneB].includes(me);
  if (needed) pauseMatch(ctx, m, `${seatName(m, d.seat)}'s ${d.kind} disconnected`);
});

// ───────────────────────── lobby ─────────────────────────

export const setName = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  upsertDevice(ctx, { name: cleanName(name) });
});

export const createMatch = spacetimedb.reducer({ mode: t.string(), level: t.u8(), name: t.string() }, (ctx, { mode, level, name }) => {
  if (mode !== 'ai' && mode !== 'pvp') throw new SenderError('Unknown mode');
  leaveCurrent(ctx);
  const n = cleanName(name);
  const m = blankMatch(ctx, mode, Math.min(2, level));
  m.laptopA = hex(ctx); m.nameA = n;
  if (mode === 'ai') { m.laptopB = 'AI'; m.nameB = `CPU · ${LEVELS[m.level].name}`; m.readyB = true; }
  const row = ctx.db.match.insert(m);
  upsertDevice(ctx, { kind: 'laptop', name: n, matchId: row.id, seat: 0 });
});

export const joinMatch = spacetimedb.reducer({ code: t.string(), name: t.string() }, (ctx, { code, name }) => {
  const m = ctx.db.match.code.find(code.trim().toUpperCase());
  if (!m) throw new SenderError(`No match with code ${code.toUpperCase()}`);
  const me = hex(ctx);
  if (m.laptopA === me || m.laptopB === me) return;
  if (m.mode !== 'pvp') throw new SenderError('That is a match against the CPU');
  if (m.laptopB) throw new SenderError('That match is full');
  leaveCurrent(ctx);
  const n = cleanName(name);
  ctx.db.match.id.update({ ...m, laptopB: me, nameB: n });
  upsertDevice(ctx, { kind: 'laptop', name: n, matchId: m.id, seat: 1 });
  notice(ctx, m.id, `${n} joined`);
});

/** Matchmaking: pair with whoever has been waiting longest, or wait in the queue. */
export const quickMatch = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  leaveCurrent(ctx);
  const n = cleanName(name);
  upsertDevice(ctx, { kind: 'laptop', name: n });
  const waiting = [...ctx.db.queue.iter()]
    .filter(q => !q.identity.isEqual(ctx.sender) && ctx.db.device.identity.find(q.identity)?.online)
    .sort((a, b) => (a.joinedAt.microsSinceUnixEpoch < b.joinedAt.microsSinceUnixEpoch ? -1 : 1))[0];
  if (!waiting) {
    ctx.db.queue.insert({ identity: ctx.sender, name: n, joinedAt: ctx.timestamp });
    return;
  }
  ctx.db.queue.identity.delete(waiting.identity);
  const m = blankMatch(ctx, 'pvp', 1);
  m.laptopA = waiting.identity.toHexString(); m.nameA = waiting.name;
  m.laptopB = hex(ctx); m.nameB = n;
  const row = ctx.db.match.insert(m);
  const wd = ctx.db.device.identity.find(waiting.identity);
  if (wd) ctx.db.device.identity.update({ ...wd, matchId: row.id, seat: 0 });
  upsertDevice(ctx, { matchId: row.id, seat: 1 });
});

export const leaveQueue = spacetimedb.reducer(ctx => {
  ctx.db.queue.identity.delete(ctx.sender);
});

export const leaveMatch = spacetimedb.reducer(ctx => {
  leaveCurrent(ctx);
});

/** Both laptops ready → 3-second countdown (a scheduled reducer starts the match). */
export const setReady = spacetimedb.reducer({ ready: t.bool() }, (ctx, { ready }) => {
  const { m, seat } = myLaptopSeat(ctx);
  if (m.status !== 'lobby') return;
  const next = seat === 0 ? { ...m, readyA: ready } : { ...m, readyB: ready };
  if (next.readyA && next.readyB && next.laptopB) {
    next.status = 'countdown';
    next.startsAt = now(ctx) + ms(3000);
    schedule(ctx, m.id, 'start', 3000);
  }
  ctx.db.match.id.update(next);
});

export const rematch = spacetimedb.reducer(ctx => {
  const { m } = myLaptopSeat(ctx);
  if (m.status !== 'over') return;
  ctx.db.match.id.update({
    ...m, status: 'lobby', phase: '', scoreA: 0, scoreB: 0, winner: NONE, pointNo: 0, rally: 0, longestRally: 0,
    readyA: false, readyB: m.mode === 'ai', shotSeq: m.shotSeq + 1,
  });
});

export const setPaused = spacetimedb.reducer({ paused: t.bool() }, (ctx, { paused }) => {
  const { m, seat } = myLaptopSeat(ctx);
  if (paused && m.status === 'playing') pauseMatch(ctx, m, `${seatName(m, seat)} paused`);
  else if (!paused && m.status === 'paused') {
    const missing = missingDevice(ctx, m);
    if (missing) throw new SenderError(`Waiting: ${missing}`);
    resumeMatch(ctx, m);
  }
});

// ───────────────────────── phone ─────────────────────────

/** Scanning the laptop's QR pairs this phone (its own identity) to one seat of that match. */
export const pairPhone = spacetimedb.reducer({ code: t.string(), seat: t.u8() }, (ctx, { code, seat }) => {
  const m = ctx.db.match.code.find(code.trim().toUpperCase());
  if (!m) throw new SenderError('Match not found — rescan the QR on the laptop');
  if (seat > 1 || !seatLaptop(m, seat) || isAI(m, seat)) throw new SenderError('That seat has no player');
  const me = hex(ctx);
  const prev = seatPhone(m, seat);
  if (prev && prev !== me) {
    const old = [...ctx.db.device.iter()].find(x => x.identity.toHexString() === prev);
    if (old) ctx.db.device.identity.update({ ...old, matchId: 0, seat: NONE });
  }
  ctx.db.match.id.update(seat === 0 ? { ...m, phoneA: me } : { ...m, phoneB: me });
  upsertDevice(ctx, { kind: 'phone', name: `${seatName(m, seat)}'s phone`, matchId: m.id, seat, ready: false });
  notice(ctx, m.id, `📱 ${seatName(m, seat)}'s phone paired`);
});

export const phoneStatus = spacetimedb.reducer({ ready: t.bool(), tapMode: t.bool() }, (ctx, { ready, tapMode }) => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.kind !== 'phone') throw new SenderError('Not a paired phone');
  ctx.db.device.identity.update({ ...d, ready, tapMode, online: true });
});

export const phoneSwing = spacetimedb.reducer(
  { power: t.f32(), aim: t.f32(), lag: t.u32(), dir: t.string(), slice: t.bool(), tap: t.bool() },
  (ctx, a) => {
    const d = ctx.db.device.identity.find(ctx.sender);
    if (!d || d.kind !== 'phone' || d.matchId === 0) throw new SenderError('Not a paired phone');
    ctx.db.swingEvent.insert({ matchId: d.matchId, seat: d.seat, ...a });
  }
);

export const phoneAim = spacetimedb.reducer({ aim: t.f32(), pitch: t.f32() }, (ctx, { aim, pitch }) => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.kind !== 'phone' || d.matchId === 0) return;
  ctx.db.aimEvent.insert({ matchId: d.matchId, seat: d.seat, aim, pitch });
});

/** Arm a secret move (phone or laptop). Each one works once per match; the opponent never sees it. */
export const pickSecret = spacetimedb.reducer({ move: t.string() }, (ctx, { move }) => {
  const { m, seat } = myAnySeat(ctx);
  if (m.status !== 'playing' && m.status !== 'paused') throw new SenderError('Secret moves are for live matches');
  const sec = secretOf(ctx, m.id, seat);
  if (!sec) return;
  if (move === '') { ctx.db.secret.id.update({ ...sec, armed: '' }); return; }
  if (!(SPECIALS as readonly string[]).includes(move)) throw new SenderError('Unknown move');
  const used = move === 'power' ? sec.usedPower : move === 'curve' ? sec.usedCurve : sec.usedFeint;
  if (used) throw new SenderError('Already used this match');
  ctx.db.secret.id.update({ ...sec, armed: move });
});

/** Guess the opponent's next shot while it's theirs to hit. Only your own devices see the guess. */
export const pickRead = spacetimedb.reducer({ guess: t.string() }, (ctx, { guess }) => {
  const { m, seat } = myAnySeat(ctx);
  if (m.status !== 'playing') throw new SenderError('Reads are for live rallies');
  if (guess !== '' && !READS.includes(guess)) throw new SenderError('Read drop, clear or smash');
  const s = ctx.db.shot.matchId.find(m.id);
  const theirShot = (m.phase === 'rally' && s && s.hitter === seat) || (m.phase === 'serve' && m.server !== seat);
  if (!theirShot && guess !== '') throw new SenderError('Read while your opponent is about to hit');
  const rd = readOf(ctx, m.id, seat);
  if (rd) ctx.db.readPick.id.update({ ...rd, guess, seq: m.shotSeq });
});

/** Lobby: take a scouting report into this match. Private — the opponent is never told. */
export const setScout = spacetimedb.reducer({ on: t.bool() }, (ctx, { on }) => {
  const { m, seat } = myLaptopSeat(ctx);
  if (m.status !== 'lobby') throw new SenderError('Choose scouting before the match starts');
  const cur = [...ctx.db.loadout.matchId.filter(m.id)].find(l => l.seat === seat);
  if (cur) ctx.db.loadout.id.update({ ...cur, scout: on });
  else ctx.db.loadout.insert({ id: 0, matchId: m.id, seat, scout: on });
});

/** Lobby (host): allow fog of war to roll in during the match. */
export const setFog = spacetimedb.reducer({ on: t.bool() }, (ctx, { on }) => {
  const { m, seat } = myLaptopSeat(ctx);
  if (m.status !== 'lobby') throw new SenderError('Set fog before the match starts');
  if (seat !== 0) throw new SenderError('Only the host can change fog');
  ctx.db.match.id.update({ ...m, fogEnabled: on });
});

// ───────────────────────── play ─────────────────────────

export const serve = spacetimedb.reducer({ power: t.f32(), aim: t.f32() }, (ctx, { power, aim }) => {
  const { m, seat } = myLaptopSeat(ctx);
  if (m.status !== 'playing' || m.phase !== 'serve' || m.server !== seat) return;
  serveFor(ctx, m, power, aim);
});

/** Most network delay we accept between the server's clock and a laptop's own judgement (shot out + swing back). */
const MAX_LINK_S = 0.6;

/**
 * The receiving laptop swings at shot `seq` and reports how far off its timing was (dtMs) against its own
 * copy of the flight. The server grades the swing itself: it knows when it launched the shuttle and when
 * the shuttle reaches the contact point, so the laptop's number must agree with the server clock (allowing
 * for network delay). A doctored "perfect" from a swing that was really far off is graded on server time.
 */
export const swing = spacetimedb.reducer(
  { seq: t.u32(), power: t.f32(), aim: t.f32(), dir: t.string(), slice: t.bool(), dtMs: t.i32() },
  (ctx, { seq, power, aim, dir, slice, dtMs }) => {
    const { m, seat } = myLaptopSeat(ctx);
    if (m.status !== 'playing' || m.phase !== 'rally' || m.shotSeq !== seq) return;
    const s = ctx.db.shot.matchId.find(m.id);
    if (!s || s.hitter === seat) return;
    const pred = predictContact(shuttleFromShot(s), sideOf(seat));
    if (!pred.contact) return;
    const ideal = Number(s.launchedAt) / 1e6 + pred.contact.t / TIME_SCALE;
    const serverDt = Number(now(ctx)) / 1e6 - ideal;        // includes the network round trip
    const clientDt = dtMs / 1000;
    const link = serverDt - clientDt;
    const dt = link >= -0.08 && link <= MAX_LINK_S ? clientDt : serverDt - 0.15;
    const grade = gradeTiming(dt);
    if (!grade) return; // a whiff by the server's clock — the shuttle keeps falling
    hit(ctx, m, seat, Math.max(0, Math.min(1.2, power)), Math.max(-1, Math.min(1, aim)), grade, { dir, slice });
  }
);

// ───────────────────────── scheduled reducers ─────────────────────────

export const onTimer = spacetimedb.reducer({ onSchedule: timer }, { arg: timer.rowType }, (ctx, { arg }) => {
  const m = ctx.db.match.id.find(arg.matchId);
  if (!m) return;
  switch (arg.kind) {
    case 'start':
      if (m.status === 'countdown') startPlay(ctx, m);
      return;
    case 'serve_ready': {
      if (m.status !== 'playing' || m.phase !== 'point' || m.pointNo !== arg.seq) return;
      const next = { ...m, phase: 'serve', rally: 0, shotSeq: m.shotSeq + 1 };
      // Fog of war rolls in now and then, for one or two rallies (never on the first two points).
      if (next.fogEnabled && next.fogLeft === 0 && next.pointNo >= 2 && rngOf(ctx)() < FOG_CHANCE) {
        next.fogLeft = ctx.random.integerInRange(1, 2);
        notice(ctx, m.id, `🌫 Fog of war — ${next.fogLeft === 1 ? 'this rally' : 'the next 2 rallies'}: you only see the shuttle once it crosses the net`);
      }
      ctx.db.match.id.update(next);
      drawZones(ctx, next);
      if (isAI(next, next.server)) schedule(ctx, m.id, 'ai_serve', 1300, next.shotSeq);
      else schedule(ctx, m.id, 'idle_serve', 20000, next.shotSeq);
      return;
    }
    case 'cross': {
      // Fog: the shuttle has reached the net — reveal it to everyone from here.
      if (m.status !== 'playing' || m.shotSeq !== arg.seq) return;
      const s = ctx.db.shot.matchId.find(m.id);
      if (!s || s.seq !== arg.seq) return;
      const c = crossingOf({ x: s.px, y: s.py, z: s.pz }, { x: s.vx, y: s.vy, z: s.vz });
      if (c) publishShot(ctx, s, { px: c.pos.x, py: c.pos.y, pz: c.pos.z, vx: c.vel.x, vy: c.vel.y, vz: c.vel.z }, true);
      return;
    }
    case 'ai_serve':
      if (m.status === 'playing' && m.phase === 'serve' && m.shotSeq === arg.seq) {
        const r = rngOf(ctx);
        serveFor(ctx, m, r() < 0.5 ? 0.2 : 0.6, (r() - 0.5) * 0.8);
      }
      return;
    case 'idle_serve':
      if (m.status === 'playing' && m.phase === 'serve' && m.shotSeq === arg.seq) {
        notice(ctx, m.id, `${seatName(m, m.server)} was idle — auto serve`);
        serveFor(ctx, m, 0.2, 0);
      }
      return;
    case 'ai_hit': {
      if (m.status !== 'playing' || m.phase !== 'rally' || m.shotSeq !== arg.seq) return;
      const d = JSON.parse(arg.arg) as { power: number; aim: number; grade: string; gesture: Gesture };
      const s = ctx.db.shot.matchId.find(m.id);
      if (!s) return;
      hit(ctx, m, other(s.hitter), d.power, d.aim, d.grade, d.gesture);
      return;
    }
    case 'land': {
      if (m.status !== 'playing' || m.phase !== 'rally' || m.shotSeq !== arg.seq) return;
      const s = ctx.db.shot.matchId.find(m.id);
      if (!s) return;
      const hitter = s.hitter;
      const owner = s.landZ > 0 ? 0 : 1;
      if (!s.landIn) endRally(ctx, m, other(hitter), 'OUT!', s);
      else if (owner === hitter) endRally(ctx, m, other(hitter), 'NET!', s);
      else endRally(ctx, m, hitter, 'WINNER!', s);
      return;
    }
  }
});

// ───────────────────────── views (per-identity visibility) ─────────────────────────

export const myDevice = spacetimedb.view({ name: 'my_device', public: true }, device.rowType.optional(), ctx => {
  return ctx.db.device.identity.find(ctx.sender) ?? undefined;
});

/** Your secret-move card — visible to your laptop and your phone, never to the opponent. */
export const mySecret = spacetimedb.view({ name: 'my_secret', public: true }, secret.rowType.optional(), ctx => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0 || d.seat === NONE) return undefined;
  return seatRow(ctx.db.secret.matchId.filter(d.matchId), d.seat) ?? undefined;
});

/** Your exact stamina. */
export const myStamina = spacetimedb.view({ name: 'my_stamina', public: true }, stamina.rowType.optional(), ctx => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0 || d.seat === NONE) return undefined;
  return seatRow(ctx.db.stamina.matchId.filter(d.matchId), d.seat) ?? undefined;
});

/** What anyone in the match may know about each player's stamina: a coarse label, not the number. */
const Condition = t.row('ConditionRow', { seat: t.u8(), label: t.string() });
export const condition = spacetimedb.view({ name: 'condition', public: true }, t.array(Condition), ctx => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0) return [];
  return [...ctx.db.stamina.matchId.filter(d.matchId)].map(s => ({
    seat: s.seat, label: s.value >= 60 ? 'fresh' : s.value >= 30 ? 'tired' : 'exhausted',
  }));
});

/** Per-player match stats, computed from the shot log on demand. */
const Stat = t.row('StatRow', {
  seat: t.u8(), shots: t.u32(), smashes: t.u32(), fastestKmh: t.f32(), perfects: t.u32(),
  drops: t.u32(), clears: t.u32(), lifts: t.u32(), specials: t.u32(), longestRally: t.u32(),
});
export const matchStats = spacetimedb.view({ name: 'match_stats', public: true }, t.array(Stat), ctx => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0) return [];
  const m = ctx.db.match.id.find(d.matchId);
  const out = [0, 1].map(seat => ({ seat, shots: 0, smashes: 0, fastestKmh: 0, perfects: 0, drops: 0, clears: 0, lifts: 0, specials: 0, longestRally: m?.longestRally ?? 0 }));
  const sealed = m?.status !== 'over';
  for (const l of ctx.db.shotLog.matchId.filter(d.matchId)) {
    const s = out[l.seat];
    if (!s || l.gameNo !== m?.gameNo) continue;
    if (sealed && l.seat !== d.seat) {
      // The opponent's real shot names and secret moves stay sealed until the match ends.
      s.shots++;
      if (l.grade === 'PERFECT!') s.perfects++;
      continue;
    }
    s.shots++;
    if (l.name === 'SMASH!') { s.smashes++; s.fastestKmh = Math.max(s.fastestKmh, l.speedKmh); }
    if (l.grade === 'PERFECT!') s.perfects++;
    if (l.name.includes('DROP') || l.name === 'NET SHOT') s.drops++;
    if (l.name === 'CLEAR') s.clears++;
    if (l.name === 'LIFT') s.lifts++;
    if (l.special) s.specials++;
  }
  return out;
});

/**
 * The shot log of your match. Your own shots are exact; the opponent's are shown as announced
 * (a feint stays a "CLEAR", secret moves are blank) until the match is over, then everything is revealed.
 * Replaces row-level security: this is the view-based access control the SpacetimeDB docs recommend.
 */
export const matchLog = spacetimedb.view({ name: 'match_log', public: true }, t.array(shotLog.rowType), ctx => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0) return [];
  const m = ctx.db.match.id.find(d.matchId);
  const over = m?.status === 'over';
  return [...ctx.db.shotLog.matchId.filter(d.matchId)].filter(l => l.gameNo === m?.gameNo).map(l =>
    over || l.seat === d.seat ? l : { ...l, name: l.shown, special: '' });
});

/** Your own shot, the moment you hit it — even in fog, when nobody else has it yet. */
export const myShot = spacetimedb.view({ name: 'my_shot', public: true }, shot.rowType.optional(), ctx => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0 || d.seat === NONE) return undefined;
  const s = ctx.db.shot.matchId.find(d.matchId);
  return s && s.hitter === d.seat ? s : undefined;
});

/** Your lobby choices (scouting), hidden from the opponent. */
export const myLoadout = spacetimedb.view({ name: 'my_loadout', public: true }, loadout.rowType.optional(), ctx => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0 || d.seat === NONE) return undefined;
  return seatRow(ctx.db.loadout.matchId.filter(d.matchId), d.seat) ?? undefined;
});

/** Your current read (guess) — never sent to the opponent. */
export const myRead = spacetimedb.view({ name: 'my_read', public: true }, readPick.rowType.optional(), ctx => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0 || d.seat === NONE) return undefined;
  return seatRow(ctx.db.readPick.matchId.filter(d.matchId), d.seat) ?? undefined;
});

/** Your secret bonus zone on the opponent's court. */
export const myTarget = spacetimedb.view({ name: 'my_target', public: true }, targetZone.rowType.optional(), ctx => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0 || d.seat === NONE) return undefined;
  return seatRow(ctx.db.targetZone.matchId.filter(d.matchId), d.seat) ?? undefined;
});

/** Your scouting report on the opponent — empty until you spend your one scout. Built from the point log. */
const ScoutLine = t.row('ScoutLine', { label: t.string(), detail: t.string() });
export const scoutingReport = spacetimedb.view({ name: 'scouting_report', public: true }, t.array(ScoutLine), ctx => {
  const d = ctx.db.device.identity.find(ctx.sender);
  if (!d || d.matchId === 0 || d.seat === NONE) return [];
  const sec = seatRow(ctx.db.secret.matchId.filter(d.matchId), d.seat);
  if (!sec || !sec.scouted) return [];
  const me = d.seat, opp = other(me);
  const game = ctx.db.match.id.find(d.matchId)?.gameNo;
  const pts = [...ctx.db.pointLog.matchId.filter(d.matchId)].filter(p => p.gameNo === game);
  const lost = pts.filter(p => p.winner === me);
  if (lost.length < 2) return [{ label: 'Not enough data yet', detail: `They have only lost ${lost.length} point${lost.length === 1 ? '' : 's'} so far — the report updates live.` }];
  const out: { label: string; detail: string }[] = [];
  const errors = lost.filter(p => p.lastHitter === opp);
  const out_ = errors.filter(p => p.reason === 'OUT!').length, net = errors.filter(p => p.reason === 'NET!').length;
  out.push({ label: 'Unforced errors', detail: `${errors.length} of ${lost.length} lost points (${out_} out, ${net} into the net)` });
  const beaten = lost.filter(p => p.lastHitter === me);
  if (beaten.length) {
    const by: Record<string, number> = { drop: 0, clear: 0, smash: 0 };
    for (const p of beaten) by[categoryOf(p.lastShot)]++;
    const worst = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
    const label = worst[0] === 'drop' ? 'drops and net shots' : worst[0] === 'clear' ? 'clears and lifts' : 'smashes and drives';
    out.push({ label: 'Weak against', detail: `${label} — ${worst[1]} of ${beaten.length} winners you hit` });
    // Their right = +x for seat 0 (facing −Z), −x for seat 1. Right-handed: right = forehand.
    const back = beaten.filter(p => (opp === 0 ? p.landX : -p.landX) < -0.3).length;
    const fore = beaten.filter(p => (opp === 0 ? p.landX : -p.landX) > 0.3).length;
    if (back !== fore) out.push({ label: 'Weaker side', detail: `${back > fore ? 'backhand' : 'forehand'} — ${Math.max(back, fore)} of ${beaten.length} winners landed there` });
    const deep = beaten.filter(p => Math.abs(p.landZ) > HALF_L - 2).length, short = beaten.filter(p => Math.abs(p.landZ) < 2.5).length;
    if (deep !== short) out.push({ label: 'Depth', detail: deep > short ? `struggles at the back — ${deep} winners landed deep` : `slow to the net — ${short} winners landed short` });
  }
  return out;
});
