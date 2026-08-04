/**
 * Local identity + room history.
 *
 * `playerId` is the reconnect key: the server matches on it to hand back the
 * same seat, hand and score after a refresh or a dropped connection, so it must
 * survive a reload and must not be regenerated casually.
 */

const ID_KEY = 'peril.playerId'
const NAME_KEY = 'peril.name'
const HUE_KEY = 'peril.hue'
const ROOMS_KEY = 'peril.rooms.v2'

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private browsing — fall back to per-session identity */
  }
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `p-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export function playerId(): string {
  let id = safeGet(ID_KEY)
  if (!id) {
    id = uuid()
    safeSet(ID_KEY, id)
  }
  return id
}

export function playerName(): string {
  return safeGet(NAME_KEY) ?? ''
}

export function setPlayerName(name: string) {
  safeSet(NAME_KEY, name.slice(0, 18))
}

export function avatarHue(): number {
  const raw = safeGet(HUE_KEY)
  if (raw !== null) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  const hue = Math.floor(Math.random() * 360)
  safeSet(HUE_KEY, String(hue))
  return hue
}

export function setAvatarHue(hue: number) {
  safeSet(HUE_KEY, String(Math.round(hue) % 360))
}

export type RecentRoom = { code: string; name: string; at: number }

export function rememberRoom(code: string, name: string) {
  try {
    const map = JSON.parse(safeGet(ROOMS_KEY) ?? '{}') as Record<string, RecentRoom>
    map[code] = { code, name, at: Date.now() }
    safeSet(ROOMS_KEY, JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

export function recentRooms(): RecentRoom[] {
  try {
    const map = JSON.parse(safeGet(ROOMS_KEY) ?? '{}') as Record<string, RecentRoom>
    return Object.values(map)
      .sort((a, b) => b.at - a.at)
      .slice(0, 6)
  } catch {
    return []
  }
}

/** Room code from the URL path (`/ABCDE`) or `?room=` query. */
export function roomCodeFromUrl(): string {
  const path = location.pathname.replace(/^\/+|\/+$/g, '').toUpperCase()
  if (/^[A-Z0-9]{4,6}$/.test(path)) return path
  const q = new URLSearchParams(location.search).get('room')
  return (q ?? '').toUpperCase().trim()
}

export function setUrlRoom(code: string) {
  if (!code) return
  const next = `/${code}`
  if (location.pathname !== next) {
    history.replaceState(null, '', next)
  }
}
