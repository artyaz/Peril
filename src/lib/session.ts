export type SessionPlayer = {
  id: string
  name: string
  roomCode: string
  faceDataUrl?: string
  lastIpHint?: string
  createdAt: number
}

const KEY = 'peril.session.v1'
const ROOMS_KEY = 'peril.rooms.v1'

export function loadSession(): SessionPlayer | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as SessionPlayer) : null
  } catch {
    return null
  }
}

export function saveSession(session: SessionPlayer) {
  localStorage.setItem(KEY, JSON.stringify(session))
}

export function clearSession() {
  localStorage.removeItem(KEY)
}

export function rememberRoom(code: string, name: string) {
  try {
    const map = JSON.parse(localStorage.getItem(ROOMS_KEY) || '{}') as Record<string, { name: string; at: number }>
    map[code] = { name, at: Date.now() }
    localStorage.setItem(ROOMS_KEY, JSON.stringify(map))
  } catch { /* ignore */ }
}

export function recentRooms(): Array<{ code: string; name: string; at: number }> {
  try {
    const map = JSON.parse(localStorage.getItem(ROOMS_KEY) || '{}') as Record<string, { name: string; at: number }>
    return Object.entries(map)
      .map(([code, v]) => ({ code, ...v }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 8)
  } catch {
    return []
  }
}

export function makePlayerId() {
  return crypto.randomUUID()
}

export function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}
