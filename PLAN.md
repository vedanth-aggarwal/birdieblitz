# Birdie Blitz — Badminton on your laptop, swung with your phone

The laptop (or TV) shows the game. Your phone is the racket: scan a QR code, calibrate in 20 seconds,
then swing your phone like a racket. No camera / CV — the phone's motion sensors (gyroscope +
accelerometer) detect the swing. Art style: stylized "Nintendo Switch Sports".

---

## 1. How it works

```
 ┌──────────── Laptop browser ─────────────┐         ┌──────── Phone browser ────────┐
 │ index.html — 3D game (Three.js)          │         │ phone.html — controller       │
 │  • shows QR + room code                  │  QR →   │  • motion permission (iOS)    │
 │  • physics, CPU, scoring, rendering      │         │  • calibration wizard         │
 │  • receives swings / orientation         │         │  • swing detection (gyro+acc) │
 └───────────────▲──────────────────────────┘         └──────────────┬────────────────┘
                 │ WebSocket  { swing, orient, calib }                │ WebSocket
                 └──────────────── server.js (Node) ◄─────────────────┘
                     • serves files over HTTP (laptop) + HTTPS (phone)
                     • pairs host ⇄ phone by 4-letter room code, relays messages
                     • generates QR codes (SVG)
```

- **Why HTTPS for the phone:** browsers only expose motion sensors in a secure context. Locally the
  server makes a self-signed certificate (accept the warning once on the phone). Online (Render/Fly/
  Railway) the host provides real HTTPS automatically.
- **Latency:** phone → laptop over Wi-Fi is ~10–40 ms. The phone sends the swing the moment it starts
  (plus how long it measured the peak), and the laptop back-dates the swing by that amount.

---

## 2. Gameplay design (Switch Sports style)

- **Auto-movement:** your character runs to the shuttle automatically. You only time and shape the swing.
- **Timing ring:** a ring shrinks around the contact point — swing when it closes.
  Timing grade: **PERFECT** (±70 ms) · **GOOD** (±150 ms) · **EARLY/LATE** (±260 ms) · otherwise whiff.
- **Shot = contact height × swing strength** (decided by the game, no buttons):

| Contact | Gentle swing | Medium swing | Hard swing |
|---|---|---|---|
| Overhead (> 1.9 m) | **Drop** (just over net) | **Clear** (high & deep) | **SMASH** (fast & steep) |
| Mid (1.0–1.9 m) | **Net drop** | **Drive** (flat & fast) | **Drive** (faster) |
| Low (< 1.0 m) | **Net shot** | **Lift** (high & deep) | **Lift** (deeper) |

- **Aim:** point/twist the phone left or right while swinging (relative to the calibrated center).
  A live aim marker on the opponent's court shows where you're pointing.
- **Accuracy:** PERFECT timing lands on target; worse timing adds error, weaker power, and can go out.
- **Rules:** rally scoring to 11 (configurable 21), win by 2, cap at 15. Winner of the rally serves.
  Serve = swing when prompted (gentle = short serve, harder = long serve).
  Shuttle lands **in** on your side → you lose the rally; lands **out** / hits the net → the hitter loses.
  Smart play: don't swing at shots that are going out!
- **CPU opponent:** same auto-move + shot system. Difficulty sets reaction speed, run speed,
  smash frequency, aim width and error rate. It also lets "out" shots go.

---

## 3. Phone controller

1. **Connect** — opens from QR with `?room=CODE`, joins over WebSocket, shows "Connected to laptop ✓".
2. **Enable motion** — button that calls `DeviceMotionEvent.requestPermission()` on iOS (required user tap).
3. **Calibrate**
   - *Center:* hold phone like a racket, point at the screen, tap **Set center** (stores yaw/roll reference).
   - *Gentle swings ×3:* records peak swing intensity of soft swings.
   - *Hard swings ×3:* records peak of full swings.
   - Thresholds: trigger = 55 % of gentle peak; power 0→1 mapped from gentle → hard.
   - Saved in `localStorage` (try/catch) so returning players can skip.
4. **Play screen** — big racket graphic, live swing meter, last shot + timing grade, score mirror,
   haptic buzz on hit (Android `navigator.vibrate`), screen wake lock, **Recalibrate** button,
   and a big **TAP TO SWING** button as a fallback for phones without sensors.

**Swing detection:** intensity = max(|gyro| / 1 rad·s⁻¹ scale, |linear accel| scale) sampled at the
device rate (60–100 Hz). Rising edge above trigger → start; track the peak for ≤ 70 ms; emit
`{type:'swing', power, lag}`; 350 ms cooldown. Orientation streamed at ~30 Hz for the racket animation and aim marker.

---

## 4. Physics

- Shuttlecock: gravity + quadratic drag `a = g − k·|v|·v`, terminal velocity ≈ 6.8 m/s (k ≈ 0.21).
  That's what gives the real "fast then floats down" feel. Shuttle mesh points cork-first along velocity.
- Game time scale 0.85 for readability.
- **Shot solver:** for a target landing point and a shot speed, scan launch pitch along the heading,
  simulate each candidate, keep the one that clears the net with margin and lands closest to the target
  (high branch for clears/lifts, low branch for smashes/drives/drops).
- Contact prediction: simulate forward to find where the shuttle descends through the ideal hitting
  height on your side → that's where you auto-run and when the timing ring closes.

Court: 13.4 m × 5.18 m (singles), net 1.55 m. Player near side (+Z), CPU far side (−Z).

---

## 5. Files

```
birdie-blitz/
├── PLAN.md
├── package.json          ← deps: ws, selfsigned, qrcode
├── server.js             ← HTTP :8080 + HTTPS :8443, WebSocket rooms, QR, LAN IP detection
└── public/
    ├── index.html        ← laptop: title/QR screen, HUD, pause, results
    ├── phone.html        ← phone: connect → permission → calibrate → controller
    ├── style.css         ← shared console-style UI (Fredoka, chunky buttons)
    └── src/
        ├── main.js       ← game state machine, rally/serve/scoring, input routing
        ├── net.js        ← laptop WebSocket client (room, phone status, messages)
        ├── scene.js      ← park arena, court, net, characters, rackets, shuttle, post-FX
        ├── physics.js    ← shuttle drag integrator, net/ground, shot solver, contact prediction
        ├── shots.js      ← shot selection from height/power/timing/aim (player + CPU)
        ├── ai.js         ← CPU decision making + difficulty
        ├── fx.js         ← trail, timing ring, landing marker, aim marker, sparks, shake
        ├── audio.js      ← synthesized SFX
        ├── hud.js        ← scoreboard, callouts, phone status, toasts
        └── phone.js      ← phone controller logic (sensors, calibration, swing detection)
```

---

## 6. Build checklist

1. [x] Plan
2. [x] Server: static files, HTTPS cert, rooms + relay, QR endpoint, LAN URL
3. [x] Phone page: connect, permission, calibration, swing detection, play screen, fallbacks
4. [x] Scene: arena, court, net, characters, shuttle, lighting, post-FX
5. [x] Physics + shot solver + contact prediction
6. [x] Game loop: serve/rally/score, auto-move, timing ring, CPU, callouts, sound
7. [x] Keyboard fallback on laptop (Space / Shift+Space / Z, ← → aim) for testing without a phone
8. [~] Test end-to-end: simulated phone ✅ (calibration, swing detection, relay, scoring); real phone ⏳
9. [ ] Deploy (Render/Railway/Fly — needs WebSockets) with `PUBLIC_URL` so the QR points online

---

## 7. What you need

- Laptop and phone on the **same Wi-Fi** (for local play), Node 18+.
- Phone browser: iOS Safari 13+ or Android Chrome. Accept the self-signed certificate warning once
  (local only — not needed once deployed).
- Run: `npm install && npm start`, open `http://localhost:8080` on the laptop, scan the QR.

---

## 8. Later

- 2 phones = 2-player local doubles/versus (room already supports multiple controllers by slot).
- Online versus (each player's own laptop + phone) — e.g. via SpacetimeDB rooms.
- Character customization, more arenas, tournaments, replays, haptic patterns per shot.
