/**
 * Vercel WebSocket endpoint — routed as `/api/ws`.
 *
 * Vercel Functions gained WebSocket support in June 2026. The contract is to
 * default-export a `http.Server`; Vercel performs the upgrade and hands the
 * socket to it. See https://vercel.com/docs/functions/websockets
 *
 * ── Requirements ───────────────────────────────────────────────────────────
 *   • Fluid compute must be ON (default for projects created after 2025-04-23;
 *     older projects must enable it in Project Settings → Functions).
 *   • WebSockets is a gated beta — the project needs the capability enabled.
 *
 * ── The caveat that matters for a game ─────────────────────────────────────
 * A connection is pinned to one function instance for its lifetime, but NEW
 * connections are not guaranteed to reach the SAME instance. Room state here
 * lives in memory, so if two players land on different instances they get two
 * different rooms that happen to share a code — and neither can see the other.
 *
 * That is fine for a small table where everyone joins within the same warm
 * window, and it is the fastest possible path (no store between the players).
 * It is NOT safe at scale or across a redeploy.
 *
 * If you hit split rooms, you have two options, in increasing order of effort:
 *
 *   1. Run the hub as one long-lived process (`npm start` on Fly/Railway/
 *      Render) and point the Vercel-hosted client at it:
 *          VITE_PERIL_WS=wss://your-hub.fly.dev/ws
 *      Keeps the in-memory authority model, which is what a 20 Hz game wants.
 *
 *   2. Externalise room state + presence fan-out to Redis so any instance can
 *      serve any player. Correct, but it puts a network hop in the middle of
 *      the presence path — budget for the added latency.
 *
 * Connections also close when the function reaches its max duration. The
 * client reconnects automatically and the server restores seat, hand and score
 * from the player id, so this is survivable — but see the caveat above: the
 * reconnect may land on a different instance.
 */

import http from 'node:http'
import { WebSocketServer } from 'ws'
import { Hub } from '../server/hub.js'

// Module scope: survives for the life of the instance and is shared by every
// connection it serves.
const hub = new Hub()
hub.start()

// A plain GET (no Upgrade header) doubles as the deploy health check: opening
// /api/ws in a browser should return this JSON. If you get the app's HTML
// instead, the function is not deployed and the request fell through to the
// SPA rewrite — which is exactly the failure that made "Create room" look dead.
const server = http.createServer((_req, res) => {
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(
    JSON.stringify({
      ok: true,
      service: 'peril-hub',
      runtime: 'vercel',
      hint: 'Connect over WebSocket to play.',
      ...hub.stats(),
    }),
  )
})

const wss = new WebSocketServer({ server, perMessageDeflate: false })
wss.on('connection', (ws) => hub.handleConnection(ws))

export default server
