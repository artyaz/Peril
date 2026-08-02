/**
 * Attaches the Peril hub to Vite's own HTTP server during development.
 *
 * The point is that `npm run dev` gives you a working multiplayer game on one
 * port with no proxy config and no second terminal — open two browser tabs and
 * you are testing netcode. Friction here is the difference between testing
 * multiplayer constantly and testing it never.
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Plugin } from 'vite'
import { WebSocketServer } from 'ws'
import { Hub } from './hub'

export const WS_PATH = '/ws'

export function perilServer(): Plugin {
  return {
    name: 'peril-server',
    configureServer(server) {
      const hub = new Hub()
      hub.start()

      const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

      server.httpServer?.on(
        'upgrade',
        (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          // Vite's HMR socket shares this server — only claim our own path and
          // let every other upgrade fall through to Vite's handler.
          const path = (req.url ?? '').split('?')[0]
          if (path !== WS_PATH) return
          wss.handleUpgrade(req, socket, head, (ws) => hub.handleConnection(ws))
        },
      )

      server.middlewares.use('/api/health', (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, ...hub.stats(), rooms: hub.listRooms() }))
      })

      server.httpServer?.once('listening', () => {
        server.config.logger.info(`  ➜  Peril hub:  ws://localhost:${resolvePort(server)}${WS_PATH}`)
      })
    },
  }
}

function resolvePort(server: { config: { server: { port?: number } } }): number {
  return server.config.server.port ?? 5173
}
