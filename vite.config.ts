import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

function stripLazyCssFromHtml(): Plugin {
  return {
    name: 'strip-lazy-css-from-html',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<link rel="stylesheet"[^>]*href="\/assets\/page-[^"]+"[^>]*>\n?/g, '')
        .replace(/<link rel="stylesheet"[^>]*href="\/assets\/App-[^"]+"[^>]*>\n?/g, '')
    },
  }
}

/** Keep the entry chunk free of static imports to lazy pages (Vite preload helper). */
function isolateEntry(): Plugin {
  return {
    name: 'isolate-entry',
    generateBundle(_opts, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry) continue
        // Replace `import{n as e}from"./something.js";` preload helper with local no-op
        chunk.code = chunk.code.replace(
          /import\{n as (\w+)\}from"\.\/[^"]+";/,
          'const $1=(t)=>t();',
        )
        // Drop static imports that are only for preload; keep dynamic import() calls
        chunk.imports = chunk.imports.filter((id) => {
          // imports array uses file names; clear non-runtime static deps from metadata
          return id.includes('rolldown-runtime')
        })
      }
    },
  }
}

export default defineConfig({
  plugins: [svelte(), stripLazyCssFromHtml(), isolateEntry()],
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    modulePreload: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three'
          if (
            id.includes('node_modules/svelte') ||
            id.includes('node_modules/esm-env') ||
            id.includes('node_modules/clsx')
          ) {
            return 'svelte'
          }
          if (id.includes('/src/game/')) return 'game'
          if (id.includes('/src/routes/Home')) return 'page-home'
          if (id.includes('/src/routes/Lobby')) return 'page-lobby'
          if (id.includes('/src/routes/Table')) return 'page-table'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
