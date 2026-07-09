import type {
  RoomState,
  ClientMsg,
  ServerMsg,
  ConnectionStatus,
} from './protocol'

type Handler = (msg: ServerMsg) => void

export type RoomTransport = {
  send: (msg: ClientMsg) => Promise<RoomState | undefined>
  close: () => void
  mode: 'http'
}

class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
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
  onStatus?: (status: ConnectionStatus) => void
}): RoomTransport {
  let closed = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let lastVersion = -1
  let failures = 0
  let fatal = false
  let status: ConnectionStatus = 'connecting'
  const controllers = new Set<AbortController>()

  function setStatus(next: ConnectionStatus) {
    if (status === next) return
    status = next
    opts.onStatus?.(next)
  }

  async function post(body: unknown) {
    const controller = new AbortController()
    controllers.add(controller)
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const data = await readJson(res)
      if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status)
      return data
    } finally {
      controllers.delete(controller)
    }
  }

  function stateVersion(state: RoomState) {
    return typeof state.revision === 'number'
      ? state.revision
      : state.updatedAt || 0
  }

  function acceptState(state: RoomState, force = false) {
    const version = stateVersion(state)
    if (!force && version <= lastVersion) return
    lastVersion = version
    opts.onMessage({ type: 'state', state })
  }

  void (async () => {
    try {
      opts.onStatus?.('connecting')
      const joinData = await post({
        action: 'join',
        code: opts.roomCode,
        playerId: opts.playerId,
        name: opts.name,
        faceDataUrl: opts.faceDataUrl,
        create: !!opts.create,
        roomName: opts.roomName,
        packIds: opts.packIds,
      })
      if (closed) return
      opts.onMessage({ type: 'ip', ip: joinData.ip || '0.0.0.0' })
      opts.onMessage({ type: 'joined', playerId: opts.playerId, code: joinData.code })
      if (joinData.state) {
        acceptState(joinData.state as RoomState, true)
      }
      failures = 0
      setStatus('connected')
      schedulePoll()
    } catch (e) {
      if (closed || (e instanceof DOMException && e.name === 'AbortError')) return
      fatal = e instanceof ApiError && e.status < 500
      setStatus('offline')
      opts.onError?.(e instanceof Error ? e.message : 'Connection failed')
    }
  })()

  function schedulePoll(delay = 450) {
    if (closed || fatal) return
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(() => {
      void poll()
    }, delay)
  }

  async function poll() {
    if (closed || fatal) return
    try {
      const data = await post({
        action: 'state',
        code: opts.roomCode,
        playerId: opts.playerId,
      })
      if (closed) return
      failures = 0
      setStatus('connected')
      const state = data.state as RoomState
      acceptState(state)
    } catch (e) {
      if (closed || (e instanceof DOMException && e.name === 'AbortError')) return
      failures += 1
      if (e instanceof ApiError && e.status === 404) {
        fatal = true
        setStatus('offline')
        opts.onError?.(e.message)
        return
      }
      setStatus('reconnecting')
      if (failures === 3) {
        opts.onError?.('Connection interrupted. Reconnecting…')
      }
    } finally {
      if (!fatal) schedulePoll(Math.min(450 * 2 ** Math.min(failures, 3), 3_600))
    }
  }

  async function send(msg: ClientMsg) {
    if (closed || msg.type === 'hello') return undefined
    const requestId = globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const attempt = async () => {
      const data = await post({
        action: 'act',
        code: opts.roomCode,
        playerId: opts.playerId,
        requestId,
        payload: msg,
      })
      if (data.state) {
        const state = data.state as RoomState
        acceptState(state)
        return state
      }
      return undefined
    }

    try {
      const state = await attempt()
      failures = 0
      setStatus('connected')
      return state
    } catch (error) {
      const retryable =
        !(error instanceof ApiError) ||
        error.status >= 500
      const importantAction =
        msg.type === 'next_round' ||
        msg.type === 'vote' ||
        msg.type === 'play_cards'
      if (retryable && importantAction) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 180))
          return await attempt()
        } catch (retryError) {
          const message = retryError instanceof Error ? retryError.message : 'Action failed'
          opts.onError?.(message)
          throw retryError
        }
      }
      const message = error instanceof Error ? error.message : 'Action failed'
      opts.onError?.(message)
      throw error
    }
  }

  function notifyPageLeave() {
    if (closed || !navigator.sendBeacon) return
    const body = JSON.stringify({
      action: 'act',
      code: opts.roomCode,
      playerId: opts.playerId,
      requestId: globalThis.crypto?.randomUUID?.(),
      payload: { type: 'leave' },
    })
    navigator.sendBeacon(
      '/api/rooms',
      new Blob([body], { type: 'application/json' }),
    )
  }

  window.addEventListener('pagehide', notifyPageLeave)

  return {
    mode: 'http',
    send,
    close() {
      closed = true
      window.removeEventListener('pagehide', notifyPageLeave)
      if (pollTimer) clearTimeout(pollTimer)
      for (const controller of controllers) controller.abort()
      controllers.clear()
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
  return data as {
    code: string
    name: string
    store: 'memory' | 'redis'
    state?: RoomState
  }
}

export async function joinRoomHttp(input: {
  code: string
  playerId: string
  name: string
  faceDataUrl?: string
}) {
  const res = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'join',
      code: input.code,
      playerId: input.playerId,
      name: input.name,
      faceDataUrl: input.faceDataUrl,
    }),
  })
  const data = await readJson(res)
  if (!res.ok) throw new Error(data.error || 'Could not join room')
  return data as {
    joined: true
    playerId: string
    code: string
    state: RoomState
  }
}
