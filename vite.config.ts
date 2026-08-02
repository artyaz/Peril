import { defineConfig } from 'vite'
import { perilServer } from './server/vite-plugin'

export default defineConfig({
  // The game server rides along on Vite's own HTTP server, so `npm run dev`
  // gives you real multiplayer on one port — open two tabs and you are testing
  // netcode with no proxy config and no second terminal.
  plugins: [perilServer()],
  build: {
    target: 'es2022',
    // three.js dominates the bundle; splitting it keeps app-code changes off
    // the critical path for repeat visitors.
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: {
    port: 5173,
  },
})
