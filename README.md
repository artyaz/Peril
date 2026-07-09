# Peril

A minimal, first-person 3D Cards Against Humanity table.

No accounts. Rooms are codes + names. Session lives in `localStorage` and rebinds by IP when you reconnect.

## Stack

- Vite + Svelte 5
- Three.js table scene (lazy-loaded)
- Server-authoritative HTTP room engine with monotonic state revisions
- Upstash Redis for shared production rooms (in-memory rooms in local Node)

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
2. Add **Upstash Redis** for multiplayer across serverless instances and set
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. Deploy. The API refuses to create a misleading ephemeral room when Redis is missing on Vercel.

Local full stack:

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
5. Grab cards and drag them onto the table
6. Vote from the accessible play picker or directly on a table card

## Motion

Cards track the pointer directly while held, retain the grabbed point across hand/table planes, and use sub-stepped spring physics only for hover and release motion. Deals and drops use anticipation + overshoot (`easeOutBack`).
