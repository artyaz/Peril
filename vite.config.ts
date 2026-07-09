import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

function stripLazyCssFromHtml(): Plugin {
  return {
    name: 'strip-lazy-css-from-html',
    enforce: 'post',
    transformIndexHtml(html) {
      // Keep only boot/index CSS in the HTML shell; page CSS loads with chunks.
      return html
        .replace(/<link rel="stylesheet"[^>]*href="\/assets\/page-[^"]+"[^>]*>\n?/g, '')
        .replace(/<link rel="stylesheet"[^>]*href="\/assets\/App-[^"]+"[^>]*>\n?/g, '')
    },
  }
}

/**
 * Vite injects a CSS preload helper as a static import from a random chunk.
 * Replace it with a tiny local helper so the entry stays tiny and CSS still loads
 * via the dynamic import() mapDeps path.
 */
function isolateEntry(): Plugin {
  return {
    name: 'isolate-entry',
    generateBundle(_opts, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry) continue
        // Local preload helper that also injects CSS link tags from mapDeps.
        const helper = `const __perilPreload=(loader,deps=[])=>{if(typeof document!=='undefined'){for(const d of deps){if(!d.endsWith('.css'))continue;const href='/' + d;if(document.querySelector('link[href="'+href+'"]'))continue;const l=document.createElement('link');l.rel='stylesheet';l.href=href;document.head.appendChild(l)}}return loader()};`
        chunk.code = chunk.code.replace(
          /import\{n as (\w+)\}from"\.\/[^"]+";/,
          `${helper}const $1=__perilPreload;`,
        )
        chunk.imports = chunk.imports.filter((id) => id.includes('rolldown-runtime'))
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
