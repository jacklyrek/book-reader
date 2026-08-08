import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Tests run through Vite so they resolve modules exactly the way the app does.
 *
 * Most of what's under test is pure — range parsing, matching, chapter mapping,
 * conflict resolution — and runs in plain Node. The DB suite uses
 * fake-indexeddb, and the boot smoke test opts into happy-dom with a
 * per-file `@vitest-environment` comment.
 */
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
