/**
 * node-shims.d.ts — just enough Node typing for the host to compile.
 *
 * `@types/node` is not installed and cannot be: the registry is firewalled for
 * this project, and the one thing tsconfig is allowed to change is its
 * `include`. So the exact Node surface `server/index.ts` touches is declared
 * here by hand. This is a compile-time fiction only — at runtime Node provides
 * the real thing — so each declaration is deliberately the narrow shape this
 * server uses, not the full API. If the server starts using more of Node, the
 * shim grows to match; it is not meant to stand in for the real types.
 *
 * The DOM lib (on by default at this target) already supplies `console`,
 * `performance`, `setInterval`, `TextEncoder`, and friends, so none of those
 * are redeclared here — only what the DOM lib lacks: `Buffer`, `process`, and
 * the `node:` modules.
 */

/** The subset of Node's `Buffer` the framer reads and writes. */
interface Buffer extends Uint8Array {
  readUInt16BE(offset: number): number
  readUInt32BE(offset: number): number
  writeUInt16BE(value: number, offset: number): number
  writeUInt32BE(value: number, offset: number): number
  copy(target: Buffer, targetStart?: number): number
  subarray(start?: number, end?: number): Buffer
}

interface BufferConstructor {
  alloc(size: number): Buffer
  allocUnsafe(size: number): Buffer
  concat(list: readonly Uint8Array[]): Buffer
  from(str: string, encoding?: string): Buffer
  from(data: ArrayBuffer | ArrayBufferView): Buffer
}

declare const Buffer: BufferConstructor

declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  exit(code?: number): never
  on(event: string, listener: (...args: unknown[]) => void): void
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string): Hash
    digest(encoding: 'base64' | 'hex'): string
  }
  export function createHash(algorithm: string): Hash
  export function randomUUID(): string
}

declare module 'node:net' {
  /** The socket surface the framer drives: event wiring plus raw writes. */
  export class Socket {
    destroyed: boolean
    on(event: 'data', listener: (chunk: Buffer) => void): this
    on(event: 'close', listener: () => void): this
    on(event: 'error', listener: (err: Error) => void): this
    write(data: Uint8Array | string): boolean
    destroy(): void
    setNoDelay(enable: boolean): this
  }
}

declare module 'node:http' {
  import { Socket } from 'node:net'

  export interface IncomingMessage {
    url?: string
    headers: Record<string, string | string[] | undefined>
  }

  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): void
    end(body?: string): void
  }

  export interface Server {
    listen(port: number, cb?: () => void): void
    close(cb?: () => void): void
    address(): { port: number } | string | null
    on(event: 'upgrade', listener: (req: IncomingMessage, socket: Socket, head: Buffer) => void): void
  }

  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server
}
