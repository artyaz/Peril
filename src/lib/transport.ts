import type { RoomState, ClientMsg, ServerMsg } from './protocol'

type Handler = (msg: ServerMsg) => void

export type RoomTransport = {
  send: (msg: ClientMsg) => void
  close: () => void
  mode: 'http'
}

async function readJson(res: Response) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    const hint = text.trim().slice(0, 48)
    throw new Error(
      res.ok
        ? 'Server returned non-JSON'
        : `API unavailable (${res.status}${hint ? `: ${hint}` : ''}). On Vercel, /api/rooms must be deployed.`,
    )
  }
}

/**
 * HTTP polling transport — works on Vercel serverless and local Node.
 * (WebSockets are not available on standard Vercel functions.)
 */
export function connectRoom(opts: {
  playerId: string
  name: string
  roomCode: string
  faceDataUrl?: string
  create?: boolean
  roomName?: string
  packIds?: string[]
  onMessage: Handler
  onError?: (message: string) => void
}): RoomTransport {
  let closed = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let lastUpdated = 0

  void (async () => {
    try {
      const joinRes = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'join',
          code: opts.roomCode,
          playerId: opts.playerId,
          name: opts.name,
          faceDataUrl: opts.faceDataUrl,
          create: !!opts.create,
          roomName: opts.roomName,
          packIds: opts.packIds,
        }),
      })
      const joinData = await readJson(joinRes)
      if (!joinRes.ok) throw new Error(joinData.error || 'Join failed')
      opts.onMessage({ type: 'ip', ip: joinData.ip || '0.0.0.0' })
      opts.onMessage({ type: 'joined', playerId: opts.playerId, code: joinData.code })
      if (joinData.state) {
        lastUpdated = joinData.state.updatedAt || 0
        opts.onMessage({ type: 'state', state: joinData.state as RoomState })
      }
      pollTimer = setInterval(() => {
        void poll()
      }, 800)
    } catch (e) {
      opts.onError?.(e instanceof Error ? e.message : 'Connection failed')
    }
  })()

  async function poll() {
    if (closed) return
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'state',
          code: opts.roomCode,
          playerId: opts.playerId,
        }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error || 'State failed')
      const state = data.state as RoomState
      if ((state.updatedAt || 0) !== lastUpdated) {
        lastUpdated = state.updatedAt || 0
        opts.onMessage({ type: 'state', state })
      }
    } catch {
      /* transient */
    }
  }

  function send(msg: ClientMsg) {
    if (closed || msg.type === 'hello') return
    void (async () => {
      try {
        const res = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'act',
            code: opts.roomCode,
            playerId: opts.playerId,
            payload: msg,
          }),
        })
        const data = await readJson(res)
        if (!res.ok) throw new Error(data.error || 'Action failed')
        if (data.state) {
          lastUpdated = data.state.updatedAt || Date.now()
          opts.onMessage({ type: 'state', state: data.state as RoomState })
        }
      } catch (e) {
        opts.onError?.(e instanceof Error ? e.message : 'Action failed')
      }
    })()
  }

  return {
    mode: 'http',
    send,
    close() {
      closed = true
      if (pollTimer) clearInterval(pollTimer)
    },
  }
}

export async function createRoomHttp(input: {
  name: string
  hostId: string
  playerName: string
  packIds?: string[]
  code?: string
  faceDataUrl?: string
}) {
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create',
      name: input.name,
      hostId: input.hostId,
      playerName: input.playerName,
      packIds: input.packIds || ['cah-base-set'],
      code: input.code,
      faceDataUrl: input.faceDataUrl,
      maxPlayers: 4,
    }),
  })
  const data = await readJson(res)
  if (!res.ok) throw new Error(data.error || 'Could not create room')
  return data as { code: string; name: string }
}
