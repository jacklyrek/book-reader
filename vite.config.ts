import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath } from 'node:url'

/**
 * In dev the service worker is served from `/src/sw.ts`, which is outside the
 * root scope. Browsers refuse a scope broader than the script's path unless the
 * response carries `Service-Worker-Allowed`. We need scope `/` because the SW
 * intercepts `/media/*` (§7.3).
 */
function serviceWorkerScope(): Plugin {
  return {
    name: 'pdr:service-worker-scope',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/src/sw.ts')) {
          res.setHeader('Service-Worker-Allowed', '/')
        }
        next()
      })
    },
  }
}

export default defineConfig({
  /**
   * Root by default. A GitHub *project* site lives at `/<repo>/`, so the
   * deploy workflow sets VITE_BASE. Everything that builds a URL at runtime —
   * the service worker registration, its scope, and `/media/{assetId}` — reads
   * `import.meta.env.BASE_URL` rather than assuming `/`.
   */
  base: process.env['VITE_BASE'] ?? '/',
  plugins: [serviceWorkerScope()],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      react: 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
  server: {
    host: true, // needed to open the dev server from the phone on the LAN
    port: 5173,
  },
  build: {
    target: 'safari16',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        sw: fileURLToPath(new URL('./src/sw.ts', import.meta.url)),
      },
      output: {
        // The SW must live at the origin root with a stable, unhashed name.
        entryFileNames: (chunk) =>
          chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
