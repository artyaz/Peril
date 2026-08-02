# Peril

A party card game played around a shared 3D table. Everyone in a room sees the
same world: the same felt, the same cards, and each other actually holding and
throwing them.

```bash
npm install
npm run dev          # game + server on http://localhost:5173
```

Open the URL in two tabs (or two machines on your network with `--host`) and
you are testing multiplayer. There is no second process to start and no proxy
to configure — the game server is attached to Vite's own HTTP server in dev.

---

## Architecture

```
shared/     wire protocol, binary codec, tuning constants   (imported by both ends)
server/     authoritative game engine + WebSocket hub
src/net/    client transport, clock sync, interpolation
src/game/   three.js scene, seats, cards, avatars
src/ui/     DOM overlay (home, lobby, HUD)
```

### The server is authoritative

Clients send *intent* (`play_cards`, `vote`); the server validates, mutates, and
publishes. No client can play a card it does not hold, play out of turn, judge
when it is not the judge, or start a game it does not host — each of those is a
test in the suite.

Snapshots are serialised **per viewer**. Your hand is in your snapshot and in
nobody else's, so a peer cannot read your cards by opening devtools: the bytes
never leave the server. Card backs are a visual nicety; the wire format is the
actual guarantee.

### Two channels, one socket

| Channel | Format | Rate | Carries |
|---|---|---|---|
| Control | JSON | on change | joins, phases, plays, votes, snapshots |
| Presence | binary | 20 Hz | head pose, hover, live card drags |

Presence is the hot path, so it is packed rather than stringified:

```
upload    17 bytes            (opcode, seq, yaw, pitch, flags, hover, x, y, z, rotY)
snapshot  6 + 15×players      (opcode, serverTime, count, per-player block)
```

At 8 players that is **2.5 KB/s** downstream. The same data as JSON is ~29 KB/s.

Presence is deliberately lossy: a dropped packet is superseded 50 ms later, so
it is never retried and never allowed to queue behind a congested socket. Every
packet carries a sequence number and reordered ones are discarded.

### Why it feels synchronous

Three things, and the third is the one people skip:

1. **Clock sync.** Ping/pong estimates the server clock, keeping the offset from
   the *lowest-RTT* sample in a rolling window rather than the average — a slow
   round trip means the packet sat in a queue and would bias the estimate. The
   offset is slewed, never snapped, so interpolation cannot tear.

2. **Interpolation.** Remote players are rendered ~110 ms in the past, which
   guarantees two snapshots always bracket the render time. 20 Hz network data
   becomes smooth 60–144 fps motion. The buffer repairs out-of-order arrivals
   and clamps instead of extrapolating when it starves, because a frozen avatar
   reads as "lagging" while a flying one reads as "broken".

3. **Local input is never interpolated.** Your own hand and drags are applied
   immediately and predicted forward; the server confirms afterwards. That
   asymmetry is the whole trick — your input is instant, everyone else is smooth.

Phases carry server-side deadlines, so a player who disconnects mid-round or
wanders off can never stall the table. Disconnects keep their seat, hand, and
score for 45 seconds; reconnecting restores all three.

---

## The card fan is a world object

This is the structural fix in this revision, and it is worth being explicit
about.

The previous build did `camera.add(handGroup)` — the hand was parented to the
**camera**, so it existed only in the local player's viewport. That looks fine
in a screenshot and is wrong in every other way: nobody could see anyone else
holding cards, a drag had no shared world position to replicate, and the
"table" was really N private scenes that happened to agree on the score.

Now every fan hangs off the scene graph at a real seat:

```
scene
└── seatRig[i]            position = seat ring, rotation.y = faces table centre
    ├── avatar
    └── fanAnchor         seat-local (0, 0.30, −0.14), tilted −0.62 rad
        └── cards…        arc computed from index — identical on every client
```

Consequences: everyone sees everyone's fan at identical coordinates; a drag
replicates as three numbers in table space; lighting, shadows and occlusion are
consistent for all; and the local player's fan is simply the one their camera
sits behind — no special case in the renderer.

Fan slot positions are a *pure function of card index*, so remote fans need no
positional data on the wire at all — only a card count.

The fan geometry is tuned against the camera rather than by eye. At seat radius
0.95 with a 0.42 m eye height and 54° vertical FOV, cards at `FAN_Y 0.23` land
28.3° below the view axis against a 27° frame edge — cropped. The shipped values
put them between 0.7° and 22° below axis. The local player's own avatar is
hidden for them alone, since the camera occupies the same point as their head.

---

## Avatars

`public/models/msn-character.glb` is a **drop-in slot**. The referenced
Sketchfab model reports `isDownloadable: false` with no licence attached, so it
cannot be fetched or vendored — and no substitute has been silently swapped in.
Until the file is supplied, every seat renders a procedural fallback and the
game is fully playable.

See [`public/models/README.md`](public/models/README.md) for how to enable it
and what the loader normalises.

---

## Physics

Springs are integrated at a **fixed 1/120 s substep** rather than with the raw
frame delta. A variable `dt` changes effective stiffness with frame rate, so
cards would behave differently on a 144 Hz monitor than a 60 Hz one — and in
multiplayer everyone should see the same throw. Long frames (a backgrounded tab)
are clamped so the integrator cannot detonate on resume.

Throws are ballistic: drag velocity is captured with smoothing, carried into a
gravity-integrated arc, and handed to a spring on landing for the settle. Cards
released short of the table spring back to the fan *carrying their momentum*,
so the snap-back is elastic rather than a teleport.

---

## Optimisation notes

- One shadow-casting light, frustum pulled tight around the table — fill and rim
  lights are shadowless, so there is a single shadow pass per frame.
- Card geometry and the body/back materials are shared by every card in the
  scene. Face textures are cached by text with a bounded LRU, and a remote
  player's hand allocates **zero** textures because those faces are never sent.
- Presence encode is skipped entirely for rooms with fewer than two clients, and
  never queued on a socket with a backlog.
- Snapshots go out only when the room revision actually changes.
- One 20 Hz timer drives every room; N rooms do not mean N drifting intervals.
- `three` is split into its own chunk (~144 KB gzip) so app changes do not
  invalidate it. App code is ~31 KB gzip.

---

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Vite + game server on one port |
| `npm test` | Headless netcode suite (60 assertions, real sockets) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Typecheck, then production bundle |
| `npm start` | Standalone server serving `dist/` |

`GET /api/health` reports uptime, client count, and live rooms.

### Deploying

The client talks to **`/api/ws`** in every environment. The dev plugin, the
standalone server and Vercel's file routing all answer on that path, so there
is no per-environment branching. Override it with `VITE_PERIL_WS` when the hub
lives somewhere other than the site.

#### Option A — one long-lived process (recommended)

```bash
npm run build && npm start
```

Fly, Railway, Render, a VPS. The hub keeps rooms in memory with a single writer,
which is exactly what a 20 Hz authoritative game wants: no store in the middle
of the presence path.

#### Option B — Vercel

Vercel Functions [gained WebSocket support in June 2026](https://vercel.com/docs/functions/websockets),
so `api/ws.ts` works there directly. Requirements:

- **Fluid compute** must be enabled (default for projects created on or after
  2025-04-23; older projects must turn it on in Project Settings → Functions).
- WebSockets is a gated beta — the project needs the capability enabled.

⚠️ **The caveat that matters for a game.** A connection is pinned to one
function instance, but *new* connections are not guaranteed to reach the *same*
instance. Room state here is in-memory, so two players who land on different
instances get two different rooms sharing a code — invisible to each other.
That is fine for a small table joining inside one warm window, and it is the
lowest-latency path. It is not safe across a redeploy or at scale.

If you hit split rooms: point the Vercel-hosted client at a dedicated hub
(Option A) with `VITE_PERIL_WS=wss://your-hub.fly.dev/ws`, or externalise rooms
and presence fan-out to Redis — correct, but it puts a network hop in the
presence path.

Connections also close at the function's max duration. The client reconnects
automatically and the server restores seat, hand and score from the player id,
so that is survivable — subject to the same instance caveat.

#### Not an option

Serving the client as static files with **no** WebSocket endpoint. `/ws` then
falls through to the SPA handler, returns HTML, and every upgrade fails. The
client now surfaces this instead of failing silently, but it still cannot play.

---

## Tests

`npm test` starts a real hub on a real socket and drives it with real
WebSocket clients. It covers codec round-trips and quantisation error,
interpolation (including the ±π seam and out-of-order arrival), room lifecycle,
seat assignment, capacity limits, phase progression, server authority, snapshot
convergence across three clients, presence propagation and broadcast rate,
reconnect, and — the one that matters most — that a peer's snapshot contains
none of your card text.
