import { defineConfig } from 'tsdown'
export default defineConfig({ entry: { 'smoke-plugin': 'smoke-plugin.ts' }, outDir: '../.smoke', fixedExtension: false, platform: 'node', format: 'esm', dts: false, deps: { neverBundle: () => true } })
