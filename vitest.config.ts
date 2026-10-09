import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  resolve: {
    alias: { '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('../deepseek-harness/packages/client/ui-primitives/src/index.ts', import.meta.url)) },
    dedupe: ['react', 'react-dom'],
  },
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], testTimeout: 10000, hookTimeout: 10000, execArgv: process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : [] },
})
