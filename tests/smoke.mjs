/** Launch the keyless Web fixture through a temporary DSH profile. */
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const project = fileURLToPath(new URL('../', import.meta.url))
const harness = resolve(project, process.env.DSH_SOURCE ?? '../deepseek-harness')
const manual = process.argv.includes('--manual')
const home = await mkdtemp(join(tmpdir(), 'dsh-progress-smoke-'))
const profile = join(home, 'profiles/smoke')
await mkdir(join(profile, 'node_modules/@kermanx'), { recursive: true })
await symlink(project, join(profile, 'node_modules/@kermanx/dsh-progress-check'))
await writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-progress-smoke', private: true,
  dependencies: { '@kermanx/dsh-progress-check': `link:${project}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@kermanx/dsh-progress-check'] } },
}) + '\n')
await writeFile(join(profile, 'cordis.patch.yml'), `- id: progress-check\n  config:\n    intervalMs: ${manual ? 60000 : 1000}\n    intervalSteps: 1\n- insert:\n    - id: progress-smoke\n      name: ${JSON.stringify(join(project, '.smoke/smoke-plugin.js'))}\n`)
console.info('Smoke profile:', profile)
const child = spawn(process.execPath, ['--import', 'tsx/esm', resolve(harness, 'apps/cli/src/bin.ts'), '--profile', 'smoke', '--patch', resolve(harness, 'apps/web/tests/pin-browse-picker.overlay.yml'), '--no-open', '--port', '0'], {
  cwd: harness, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, stdio: 'inherit',
})
const stop = () => child.kill('SIGTERM')
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try {
  await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
} finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  await rm(home, { recursive: true, force: true })
}
