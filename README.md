# Birdie Blitz — SpacetimeDB edition

Badminton on your laptop, swung with your phone. Play **1v1 across two laptops** (each player with
their own phone as a racket) or **against the CPU**. SpacetimeDB is the referee: laptops and phones
are thin clients, and every shot, landing, point, secret move and CPU decision happens inside the
database.

```
 Phone A ──reducers──►┐                         ┌◄──reducers── Phone B
                      │      SpacetimeDB        │
 Laptop A ◄─subscr.──►│  match · shot · shot_log│◄─subscr.──► Laptop B
                      │  views · event tables   │
                      │  schedule timers · AI   │──► spectators (?watch=CODE)
                      └─────────────────────────┘
```

## Headline: fog of war, enforced by the database

Turn on **🌫 Fog of war** in the lobby. Now and then (30% per point, from the third point on), fog rolls in
for one or two rallies. The opponent's half goes dark and you only see the shuttle once it crosses the net.

This isn't a screen effect. The opponent's shot is never sent to your laptop until it reaches the net:
- The real shuttle lives in a **private** `shot` table.
- The hitter gets their own shot instantly through the per-player `my_shot` **view**.
- Everyone else reads the public `shot_feed` table, which in fog is written only by a **scheduled reducer** (`cross`) at the moment the shuttle crosses the net, carrying its position and speed at the net.

In testing, the CPU's fogged shots reached the other laptop at z ≈ 0.0 (the net), 0.57–0.78 s after they
were hit. Opening developer tools on your laptop shows nothing, because the data isn't there yet.

## How SpacetimeDB is used

| Feature | SpacetimeDB piece | How |
|---|---|---|
| **QR phone pairing** | Identity, `pair_phone` reducer, `device` table | The laptop's QR carries match code + seat. The phone's own identity is linked to that seat. No room server. |
| **1v1 on two laptops** | `match` table, `create_match` / `join_match` / `set_ready` | Invite link `?join=CODE`. Both ready → 3-2-1 countdown started by a scheduled reducer. |
| **Server-decided shots** | `swing` / `serve` reducers + shared `core.ts` physics | The laptop only reports *how far off its timing was + gesture + power + aim*. The server works out the contact point, stamina, secret move, read bonus and launch vector, then writes the `shot` row. Both screens animate the same flight from it. |
| **Server-checked timing** | `swing` reducer + `ctx.timestamp` | The server knows when it launched the shuttle and when it reaches the contact point. The laptop's timing must agree with the server clock (allowing for network delay), or the swing is graded on server time. A faked "PERFECT" sent 0.8 s early is rejected. |
| **Landing & scoring without a game loop** | Schedule table (`timer`, one-shot) | At launch the server simulates the flight once and schedules a `land` timer for the touchdown. One write per hit, no 20 Hz tick. Stale timers are ignored by `shotSeq`. |
| **CPU opponent** | Scheduled reducers | The AI lives in the database: on launch it predicts the contact, decides the shot and schedules `ai_hit` at contact time plus its timing error. It even uses secret moves. |
| **Secret moves** (Power / Curve / Feint) | Private `secret` table + `my_secret` view | Armed from the phone or keys 1-2-3. Only your own laptop and phone can see it. The opponent's client never receives it. A feint is announced as a clear/drive while the server plays a drop. |
| **Hidden stamina** | Private `stamina` table, `my_stamina` + `condition` views | You see your exact bar. The opponent only gets "fresh / tired / exhausted". Below 30, you can't swing at full power (no smash). |
| **Auto-pause on disconnect** | `clientDisconnected` / `clientConnected` lifecycle reducers | A laptop or paired phone drops → match pauses for everyone. It reconnects with the same identity → resumes and replays the point. |
| **Reads (shot prediction)** | Private `read_pick` table, `my_read` view, `read_event` | While the opponent is about to hit, guess drop / clear / smash on your phone (or Q/W/E). The guess is never sent to them. It is checked against the *real* shot (a feint can't fool a drop read): right = your next swing is graded one step better, wrong = −5 stamina. `read_event` reveals it afterwards. The CPU reads too. |
| **Secret target zones** | Private `target_zone` table, `my_target` view | Every point, each player gets a hidden bonus zone on the opponent's court, drawn only on their own screen. A winner landing inside it is a 🎯 bullseye: +25 stamina. The CPU aims for its own zone half the time. |
| **Scouting report** (lobby option) | Private `loadout` + `point_log` tables, `my_loadout` + `scouting_report` views | Tick it in the lobby before the match. During play you get a live, private report on the opponent's weaknesses (errors, shot types that beat them, weaker side, depth), computed from how every point ended. The opponent never learns you chose it. |
| **Fog of war** (lobby option) | Private `shot`, public `shot_feed`, `my_shot` view, scheduled `cross` reducer | See above: the opponent's shot is withheld from your client until it crosses the net. |
| **Sealed shot log** | Private `shot_log` + `match_log` view | Your own shots are exact. The opponent's are shown as announced (a feint stays a "CLEAR", secret moves blank) until the match ends, then everything is revealed for replay and stats. This is the view-based access control the SpacetimeDB docs recommend instead of experimental row-level security. |
| **Hit effects, vibration, swings** | Event tables: `swing_event`, `aim_event`, `hit_event`, `rally_event`, `read_event`, `notice_event` | Broadcast once, never stored. Phone swing → laptop, hit → phone vibrates, rally result → callouts. |
| **Instant replay** | `match_log` view over `shot_log` | Every hit is logged with its launch vector. At match end the game stays on the court; replay the last or the best rally at ½× or ¼×. |
| **Match stats** | `match_stats` view | Shots, smashes, fastest smash, perfect hits, drops, clears/lifts, secret moves and longest rally. The opponent's secret moves stay hidden until the match is over. |
| **History across rematches** | `game_no` on `shot_log` / `point_log` | Every game is kept for SQL. Views show only the current game. |
| **Matchmaking** | `queue` table, `quick_match` | Pairs you with whoever has been waiting longest. |
| **Hall of fame** | `hall_of_fame` table | Written when a match ends, with the fastest smash and longest rally. |
| **Live matches + spectators** | Public `match` subscription | The menu lists every match being played right now. Click 👀 Watch, or open `/?watch=CODE`. Spectators never receive anyone's private data. |
| **Idle auto-serve** | One-shot timer | A player who doesn't serve within 20 s gets an automatic short serve. |
| **Type-safe clients** | `spacetime generate` | Laptop and phone use bindings generated from the module schema. |

The shuttle physics (`spacetimedb/src/core.ts`) is **one file shared by the server and the browser**,
so the referee and the animation can never disagree.

### What each player can and can't see

| Data | You | Opponent | Spectators |
|---|---|---|---|
| Your armed secret move | ✅ | ❌ (only its effect) | ❌ |
| Your exact stamina | ✅ | "fresh / tired / exhausted" | ❌ |
| Your read (guess) | ✅ | ❌ until the shot is played | ❌ |
| Your target zone | ✅ | ❌ | ❌ |
| Your scouting report (and that you chose it) | ✅ | ❌ | ❌ |
| The shuttle on the opponent's half during fog | your own shot ✅ | ❌ until it crosses the net | ❌ until it crosses the net |
| The real name of a feint, secret moves in the log | ✅ (own shots) | ❌ until the match ends | ❌ |

All of it lives in private tables. Clients only ever receive it through views that check `ctx.sender`.

## Run it locally

You need the SpacetimeDB CLI with a local server running (`spacetime start`) and Node 18+.

```bash
npm install
```
```bash
cd spacetimedb && npm install && cd ..
```
```bash
npm run db:publish
```
```bash
npm run dev
```

Open <http://localhost:5180>. To try 1v1 on one machine, open a second browser tab: each tab is its
own identity. Keyboard: Space clear/drive · X smash · C lift · Z drop · ←/→ aim · 1/2/3 secret moves ·
Q/W/E read · S scouting report · P pause. (`npm run dev:hmr` turns on Vite live reload for development. It is off
by default because a dropped live-reload socket through a tunnel reloads the page mid-match.)

### Phones and a second laptop

Phones need HTTPS for motion sensors. Vite proxies `/v1` to the local SpacetimeDB, so **one tunnel
serves the pages, the WebSocket and the database**:

```bash
cloudflared tunnel --url http://localhost:5180
```

Both laptops open the `https://….trycloudflare.com` address. The lobby QR and the invite link then
use that address automatically.

### Hosting on maincloud

```bash
npm run db:cloud
```

Then run the client with `VITE_STDB_URI=wss://maincloud.spacetimedb.com` (and `VITE_STDB_DB` if you
publish under a different name).

## Live SQL for the demo

```bash
spacetime sql birdie-blitz --server local "SELECT seat, name, shown, special, speed_kmh FROM shot_log WHERE special != ''"
```
```bash
spacetime sql birdie-blitz --server local "SELECT winner, loser, score, fastest_smash_kmh FROM hall_of_fame"
```
```bash
spacetime sql birdie-blitz --server local "SELECT name, speed_kmh FROM shot_log WHERE name = 'SMASH!' ORDER BY speed_kmh DESC"
```
```bash
spacetime sql birdie-blitz --server local "SELECT game_no, point_no, winner, reason, last_shot, bullseye FROM point_log"
```
The database owner can query private tables. Players' clients can't.

## Layout

```
spacetimedb/src/index.ts   module: tables, reducers, views, schedules, lifecycle, RLS
spacetimedb/src/core.ts    shared physics, shot rules, timing, AI brain
src/main.js                laptop: rendering, timing judgement, lobby/menus
src/phone.js               phone controller: sensors, gestures, pairing, secret moves
src/stdb.js                connection helper (per-tab identity, auto-reconnect)
src/module_bindings/       generated by `npm run db:generate`
```

`PLAN.md` describes the original single-player design this edition was built from. The original
project in `../birdie-blitz` is untouched.
