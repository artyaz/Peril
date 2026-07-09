import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { createRoom, getRoom, rooms, attachClient } from './room.js'
import apiHandler from '../api/rooms.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT || 8787)
const isProd = process.env.NODE_ENV === 'production'

function clientIp(req) {
  const xf = req.headers['x-forwarded-for']
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim()
  return req.socket.remoteAddress || '0.0.0.0'
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8'
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (file.endsWith('.css')) return 'text/css; charset=utf-8'
  if (file.endsWith('.json')) return 'application/json'
  if (file.endsWith('.svg')) return 'image/svg+xml'
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

function serveStatic(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'
  const file = path.normalize(path.join(DIST, pathname))
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end()
    return
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const index = path.join(DIST, 'index.html')
    if (fs.existsSync(index)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      fs.createReadStream(index).pipe(res)
      return
    }
    res.writeHead(404).end('Not found')
    return
  }
  res.writeHead(200, { 'Content-Type': contentType(file) })
  fs.createReadStream(file).pipe(res)
}

/** Adapt Node req/res to the Vercel-style api/rooms handler. */
function runApi(req, res) {
  return apiHandler(req, {
    setHeader: (k, v) => res.setHeader(k, v),
    get statusCode() { return res.statusCode },
    set statusCode(v) { res.statusCode = v },
    end: (body) => {
      if (!res.headersSent) {
        res.setHeader('Content-Type', res.getHeader('Content-Type') || 'application/json')
      }
      res.end(body)
    },
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const ip = clientIp(req)

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true })
  }

  if (url.pathname === '/api/ip') {
    return sendJson(res, 200, { ip })
  }

  // Unified Vercel-compatible rooms API (create/join/state/act)
  if (url.pathname === '/api/rooms') {
    return runApi(req, res)
  }

  // Legacy list endpoint
  if (url.pathname === '/api/rooms/list' && req.method === 'GET') {
    const list = [...rooms.values()].map((r) => ({
      code: r.code,
      name: r.name,
      players: r.players.size,
      phase: r.phase,
      maxPlayers: r.maxPlayers,
    }))
    return sendJson(res, 200, { rooms: list })
  }

  if (isProd) return serveStatic(req, res)
  res.writeHead(404).end('API only in dev — use Vite for the client')
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws, req) => {
  const ip = clientIp(req)
  attachClient(ws, ip)
})

server.listen(PORT, () => {
  console.log(`[peril] server on :${PORT} (${isProd ? 'prod' : 'dev'})`)
})
