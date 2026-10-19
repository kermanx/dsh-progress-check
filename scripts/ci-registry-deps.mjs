#!/usr/bin/env node
/**
 * Point linked DSH devDependencies at their published versions for a CI install.
 *
 * Local development keeps `link:../deepseek-harness/...` specs, which only resolve
 * next to a DSH source checkout. CI has no sibling checkout, so every linked
 * devDependency is replaced by the version the local checkout reports; without that
 * checkout the version comes from `peerDependencies`, or from the pinned fallback
 * below for packages only the development setup needs.
 *
 * Runs as a dry run unless `--write` is passed, so a local invocation prints the
 * mapping instead of rewriting the manifest.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

/** Published versions of dev-only packages, which no peerDependency pins. */
const DEV_ONLY_VERSIONS = {
  '@deepseek-ai/dsh-tool-testkit': '0.2.1-rc.2',
  '@deepseek-ai/dsh-agent-loop': '0.2.1-rc.2',
  '@deepseek-ai/dsh-agent-loop-testkit': '0.2.1-rc.2',
  '@deepseek-ai/dsh-tools': '0.2.1-rc.2',
  '@deepseek-ai/dsh-system-prompt': '0.2.1-rc.2',
  '@deepseek-ai/dsh-session-persistence': '0.2.1-rc.2',
  '@deepseek-ai/dsh-session-persistence-jsonl': '0.2.1-rc.2',
}

const write = process.argv.includes('--write')
const replacements = []
for (const [name, spec] of Object.entries(manifest.devDependencies ?? {})) {
  if (!spec.startsWith('link:')) continue
  const target = resolve(root, spec.slice('link:'.length), 'package.json')
  let version
  if (existsSync(target)) {
    const linked = JSON.parse(readFileSync(target, 'utf8'))
    if (linked.name !== name) throw new Error(`${spec} declares ${linked.name}, expected ${name}`)
    version = linked.version
    const pinned = DEV_ONLY_VERSIONS[name]
    if (pinned !== undefined && pinned !== version) {
      console.warn(`warning: ${name} is ${version} in the checkout but pinned at ${pinned}`)
    }
  } else {
    version = manifest.peerDependencies?.[name] ?? DEV_ONLY_VERSIONS[name]
  }
  if (version === undefined) throw new Error(`no published version for linked devDependency ${name}`)
  manifest.devDependencies[name] = version
  replacements.push(`${name}@${version}`)
}
if (replacements.length === 0) throw new Error('no linked devDependencies found; nothing to replace')

if (write) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`ci-registry-deps: replaced ${replacements.length} linked devDependencies`)
} else {
  console.log(`ci-registry-deps: dry run, would replace ${replacements.length} linked devDependencies`)
}
for (const entry of replacements) console.log(`  ${entry}`)
