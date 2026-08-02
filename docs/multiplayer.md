# Multiplayer: how the table stays in sync

## Decision

**A small authoritative server running the existing solver headlessly, over binary
WebSocket. Supabase for rooms, auth and settings — never for the hot path.**

Not Supabase Realtime for state. Not Redis. Not a player's PC.

## Why this and not the others

### Not Supabase Realtime for game state

Realtime Broadcast is a good fit for chat, presence and lobby updates, and a poor
one for a continuous stream of transforms. It is JSON over a shared WebSocket
fabric with per-client message-rate limits, and every message pays a round trip
to Supabase's edge before it reaches anyone. Dragging a card produces 30–60
updates a second per player; that is the wrong shape of traffic for it.

The deeper problem is that Realtime is a *relay*. Nobody arbitrates. Two players
grabbing the same card both believe they have it, and there is nowhere to resolve
that. Worse, hidden hands cannot be enforced: a relay has to send every message
to every subscriber, so "don't expose cards in a player's fan" becomes a promise
the client makes to itself, which is no promise at all.

Supabase is still the right tool for the room list, authentication, persisted
room settings and presence. Those are low-volume and it does them well.

### Not Redis

A browser cannot speak Redis, so this always means *server plus Redis*, and the
path becomes client → your server → Redis → your server → clients. That is
strictly slower than client → your server → clients. Redis pub/sub earns its
place when many server instances must share state across regions; at four to
eight players in one room it is a hop that buys nothing.

### Not hosted on a player's PC

Genuinely tempting, and it has the best raw latency — WebRTC DataChannels are
peer-to-peer, so 20–40ms instead of 30–60ms. Three things sink it:

- **Hidden information lives on a player's machine.** The host's browser must
  hold the deck order and every hand in order to simulate. "Don't expose cards in
  a user's fan" cannot be true if another player's computer is the referee.
- **Host migration.** The host closes their laptop and the room dies, or you
  build state handover, reconnection and re-election — more work than the server
  it replaces.
- **NAT.** Perhaps 10–20% of peer connections need a TURN relay, which is a
  server you have to run anyway, and a slow one.

The latency advantage is also smaller than it looks, because it can be hidden.
See prediction below.

### Why the server suits *this* codebase specifically

The solver was built for it, whether or not that was the plan at the time:

- `src/physics.ts` has no renderer dependency and runs headless under Node today.
  The test suite already drives it that way.
- It is deterministic: fixed timestep, fixed operation order, float64 throughout.
- It already exposes `serialize()`, `applySnapshot()` and `checksum()`.

So the referee is the same code the client runs, not a reimplementation that will
drift from it. That is the single biggest source of bugs in networked physics and
it is avoided for free.

## Shape of it

**Transport.** One binary WebSocket per client to a region-pinned Node process
(Fly.io or Railway; a few dollars a month). Binary because the snapshot is
already a typed array — sending it as JSON would roughly triple it for nothing.
Float32 on the wire; float64 only inside the solver.

**Server tick.** The solver runs at its usual fixed 240Hz. Snapshots go out at
30Hz, carrying only bodies that changed since that client's last acknowledged
snapshot. A settled table sends almost nothing, which the sleep system already
makes easy to detect.

**Client → server.** Intents, never positions: `grab(bodyId, pinchPoint)`,
`moveGrab(point)`, `release()`, `take`, `drop`, `square`. Small, and the server
can reject anything illegal — including a grab on a card someone else holds.

**Hidden hands.** A hand is server state. Each client is sent the identity of its
own cards and, for everyone else, only a count and the fan's transforms. There is
nothing to leak because the data never crosses the wire.

**Latency hiding.** This is why the server's extra 10–20ms does not matter:

- *Your own card* is predicted locally. The grab is already a velocity drive
  against a target point, which is exactly the input a predictor needs — you
  keep dragging at zero perceived latency and the server reconciles behind you.
- *Everyone else's cards* are interpolated, using the `prevP`/`prevQ` and `alpha`
  machinery the renderer already has for the fixed timestep. Rendering ~100ms in
  the past makes remote motion perfectly smooth.
- *Avatars* are the easiest case: interpolate position and gaze, nobody notices.

**Divergence.** Every snapshot carries `checksum()`. A client that disagrees asks
for a full snapshot rather than drifting quietly.

## Order to build it

1. Wire protocol and codec, with round-trip tests. Pure functions, headless.
2. Headless server: the solver plus room membership. No rendering, no UI.
3. Client transport with prediction and reconciliation for the grabbed card.
4. Rooms UI, back in the style of the first version, on Supabase.
5. Avatars: glassy XP-style bodies, nickname billboards, optional face texture.
6. Card packs, card backs, and per-room table and background settings.

Steps 1–3 are where the risk is and they are testable headlessly, which is why
they come first. Steps 4–6 are additive and each is independently shippable.
