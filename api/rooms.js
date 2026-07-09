import {
  createRoom,
  saveRoom,
  joinRoom,
  stateFor,
  publicMeta,
  applyAction,
  storeMode,
  mutateRoom,
} from './_lib/engine.js'

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control', 'no-store')
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for']
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim()
  return req.socket?.remoteAddress || '0.0.0.0'
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

function send(res, status, body) {
  cors(res)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export default async function handler(req, res) {
  cors(res)
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }

  try {
    if (req.method === 'GET') {
      const store = storeMode()
      return send(res, 200, {
        ok: true,
        store,
        shared: store === 'redis',
        service: 'peril',
      })
    }

    if (req.method !== 'POST') {
      return send(res, 405, { error: 'Method not allowed' })
    }

    const body = await readBody(req)
    const action = String(body.action || '')
    const ip = clientIp(req)
    const store = storeMode()

    if (action === 'create') {
      if (process.env.VERCEL && store !== 'redis') {
        return send(res, 503, {
          code: 'SHARED_STORE_REQUIRED',
          error:
            'Multiplayer storage is not configured. Connect Upstash Redis to this deployment, then try again.',
        })
      }
      const room = await createRoom({
        name: String(body.name || 'Untitled').slice(0, 40),
        hostId: String(body.hostId || ''),
        packIds: Array.isArray(body.packIds) ? body.packIds.slice(0, 40) : ['cah-base-set'],
        maxPlayers: Math.min(4, Math.max(2, Number(body.maxPlayers) || 4)),
        code: body.code ? String(body.code).toUpperCase() : undefined,
      })
      if (body.hostId && body.name) {
        joinRoom(room, {
          playerId: String(body.hostId),
          name: String(body.playerName || body.name || 'Host'),
          faceDataUrl: body.faceDataUrl,
          ip,
        })
        await saveRoom(room)
      }
      return send(res, 200, {
        code: room.code,
        name: room.name,
        store,
        state: body.hostId ? stateFor(room, String(body.hostId)) : undefined,
      })
    }

    if (action === 'join') {
      const code = String(body.code || body.roomCode || '').toUpperCase()
      let result = await mutateRoom(code, (room) => {
        joinRoom(room, {
          playerId: String(body.playerId),
          name: String(body.name || 'Player'),
          faceDataUrl: body.faceDataUrl,
          ip,
        })
      })
      if (!result && body.create) {
        const room = await createRoom({
          name: body.roomName || 'Untitled',
          hostId: body.playerId,
          packIds: body.packIds || ['cah-base-set'],
          code,
        })
        joinRoom(room, {
          playerId: String(body.playerId),
          name: String(body.name || 'Player'),
          faceDataUrl: body.faceDataUrl,
          ip,
        })
        await saveRoom(room)
        result = { room }
      }
      if (!result) {
        return send(res, 404, {
          code: 'ROOM_NOT_FOUND',
          error: 'Room not found. Check the code or ask the host for a new invite.',
        })
      }
      const room = result.room
      return send(res, 200, {
        joined: true,
        playerId: body.playerId,
        code: room.code,
        ip,
        state: stateFor(room, body.playerId),
      })
    }

    if (action === 'state') {
      const code = String(body.code || body.roomCode || '').toUpperCase()
      const result = await mutateRoom(code, (room) => {
        applyAction(room, { type: 'tick_bots', playerId: String(body.playerId || '') })
      })
      if (!result) {
        return send(res, 404, {
          code: 'ROOM_NOT_FOUND',
          error: 'This room expired or no longer exists.',
        })
      }
      const room = result.room
      return send(res, 200, {
        state: stateFor(room, String(body.playerId || '')),
        meta: publicMeta(room),
      })
    }

    if (action === 'act') {
      const code = String(body.code || body.roomCode || '').toUpperCase()
      const requestId = String(body.requestId || '').slice(0, 80)
      const result = await mutateRoom(code, (room) => {
        room.processedActions = Array.isArray(room.processedActions)
          ? room.processedActions
          : []
        if (requestId && room.processedActions.includes(requestId)) return
        applyAction(room, {
          ...(body.payload || {}),
          type: body.payload?.type || body.type,
          playerId: String(body.playerId),
        })
        if (requestId) {
          room.processedActions.push(requestId)
          room.processedActions = room.processedActions.slice(-80)
        }
      })
      if (!result) {
        return send(res, 404, {
          code: 'ROOM_NOT_FOUND',
          error: 'This room expired or no longer exists.',
        })
      }
      const room = result.room
      return send(res, 200, { state: stateFor(room, String(body.playerId)) })
    }

    return send(res, 400, { error: 'Unknown action' })
  } catch (e) {
    return send(res, 400, { error: e.message || 'bad request' })
  }
}
