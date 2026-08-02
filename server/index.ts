/**
 * Standalone production server: serves the built client and hosts the hub.
 *
 *   npm run build && npm start
 *
 * Deliberately dependency-light (node:http + ws). Any host that gives you a
 * long-lived Node process works — Railway, Fly, Render, a VPS. Note that
 * classic serverless functions do NOT, because WebSockets need a process that
 * outlives the request; the previous HTTP-polling design existed to work around
 * that and paid for it with ~800 ms of latency on every action.
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { Hub } from './hub'

const PORT = Number(process.env.PORT ?? 8080)
const DIST = resolve(process.cwd(), 'dist')
const WS_PATH = '/ws'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.hdr': 'image/vnd.radiance',
  '.woff2': 'font/woff2',
}

const hub = new Hub()
hub.start()

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...hub.stats(), rooms: hub.listRooms() }))
    return
  }

  // Resolve inside DIST only — normalize first so `..` cannot escape.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, rel)
  if (!file.startsWith(DIST)) file = DIST

  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback: room codes live in the URL, so /ABCDE must serve the app.
    file = join(DIST, 'index.html')
  }

  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Build the client first:  npm run build')
    return
  }

  const ext = extname(file)
  const immutable = rel.startsWith('/assets/')
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(file).pipe(res)
})

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0]
  if (path !== WS_PATH) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => hub.handleConnection(ws))
})

server.listen(PORT, () => {
  console.log(`Peril server  →  http://localhost:${PORT}   (ws ${WS_PATH})`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    hub.stop()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
