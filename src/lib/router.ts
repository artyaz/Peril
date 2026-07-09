import { writable } from 'svelte/store'

export type Route =
  | { name: 'home' }
  | { name: 'lobby'; code: string }
  | { name: 'table'; code: string }

function parseHash(): Route {
  const raw = location.hash.replace(/^#\/?/, '')
  const [a, b] = raw.split('/')
  if (a === 'lobby' && b) return { name: 'lobby', code: b.toUpperCase() }
  if (a === 'table' && b) return { name: 'table', code: b.toUpperCase() }
  return { name: 'home' }
}

export const route = writable<Route>(parseHash())

export function navigate(to: Route) {
  const hash =
    to.name === 'home' ? '#/' :
    to.name === 'lobby' ? `#/lobby/${to.code}` :
    `#/table/${to.code}`
  if (location.hash !== hash) location.hash = hash
  else route.set(to)
}

window.addEventListener('hashchange', () => route.set(parseHash()))
