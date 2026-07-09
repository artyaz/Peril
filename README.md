# Peril

A minimal, first-person 3D Cards Against Humanity table.

No accounts. Rooms are codes + names. Session lives in `localStorage` and rebinds by IP when you reconnect.

## Stack

- Vite + Svelte 5
- Three.js table scene (lazy-loaded)
- Node WebSocket server for rooms

## Packs

All **205** packs from [JSON Against Humanity](https://github.com/crhallberg/json-against-humanity) ship as lazy JSON under `public/data/packs/` (71 official + fan packs). The lobby loads the index first; individual packs fetch on select.

## Dev

```bash
npm install
npm run dev
```

Client: `http://127.0.0.1:5173` · API/WS: `:8787`

## Deploy (Vercel)

Static frontend + `/api/rooms` serverless function.

1. Connect the repo to Vercel
2. Optional but recommended for multiplayer across instances: add **Upstash Redis** and set
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. Without Redis, rooms still work in-memory per serverless instance (fine for solo / same-region demos)

Local full stack (WS + API):

```bash
npm run dev
```

Production local:

```bash
npm run build && npm start
```

## Play

1. Name yourself → create or join a room code
2. Host picks packs (default: Base Set)
3. Optional face photo (stretched onto the front of your XP-gray head)
4. Start — bots auto-fill if you’re alone
5. Hover cards to peek (synced to peers), click to play, vote for the best

## Motion

Card hover/lift uses spring physics (bg3d-inspired). Deals and drops use anticipation + overshoot (`easeOutBack`). Look-closer blends the camera onto the table surface.
