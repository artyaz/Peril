export type PackMeta = {
  id: string
  name: string
  official: boolean
  w: number
  b: number
}

export type PackCards = {
  white: string[]
  black: Array<{ text: string; pick: number }>
}

export type PackIndex = {
  official: Array<{ id: string; name: string; official: boolean; whiteCount: number; blackCount: number }>
  all: PackMeta[]
}

let indexPromise: Promise<PackIndex> | null = null
const packCache = new Map<string, Promise<PackCards>>()

export function loadPackIndex() {
  if (!indexPromise) {
    indexPromise = fetch('/data/packs-index.json').then((r) => r.json())
  }
  return indexPromise
}

export function loadPack(id: string) {
  let p = packCache.get(id)
  if (!p) {
    p = fetch(`/data/packs/${id}.json`).then((r) => {
      if (!r.ok) throw new Error(`Pack ${id} missing`)
      return r.json()
    })
    packCache.set(id, p)
  }
  return p
}

export async function loadPacks(ids: string[]): Promise<PackCards> {
  const packs = await Promise.all(ids.map(loadPack))
  const white: string[] = []
  const black: Array<{ text: string; pick: number }> = []
  const seenW = new Set<string>()
  const seenB = new Set<string>()
  for (const p of packs) {
    for (const w of p.white) {
      if (seenW.has(w)) continue
      seenW.add(w)
      white.push(w)
    }
    for (const b of p.black) {
      const key = `${b.pick}|${b.text}`
      if (seenB.has(key)) continue
      seenB.add(key)
      black.push(b)
    }
  }
  return { white, black }
}

export function blankify(text: string) {
  return text.replace(/_+/g, '____')
}
