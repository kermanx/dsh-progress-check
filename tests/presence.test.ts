import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PresenceRegistry } from '../src/presence.ts'
import { PRESENCE_TTL_MS } from '../src/protocol.ts'
import { Adapter, deferred, setup } from './fixture.ts'

afterEach(() => vi.useRealTimers())
function clock() { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) }

describe('visibility gating', () => {
  it('holds automatic generation until a page shows the Session', async () => {
    const f = await setup()
    onTestFinished(f.close)
    clock(); f.start(); await f.adapter.ready.promise
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.adapter.checks).toHaveLength(0)
    f.watch()
    await vi.advanceTimersByTimeAsync(0)
    await f.waitRecords('plugin:progress-check/result')
    expect(f.adapter.checks).toHaveLength(1)
  })

  it('keeps waiting while the page stays in the background', async () => {
    const f = await setup()
    onTestFinished(f.close)
    clock(); f.start(); await f.adapter.ready.promise
    f.watch(false)
    await vi.advanceTimersByTimeAsync(600000)
    expect(f.adapter.checks).toHaveLength(0)
    f.watch()
    await vi.advanceTimersByTimeAsync(0)
    await f.waitRecords('plugin:progress-check/result')
    expect(f.adapter.checks).toHaveLength(1)
  })

  it('ignores reports that name another Session', async () => {
    const f = await setup()
    onTestFinished(f.close)
    clock(); f.start(); await f.adapter.ready.promise
    f.watch(true, SessionId('elsewhere'))
    await vi.advanceTimersByTimeAsync(600000)
    expect(f.adapter.checks).toHaveLength(0)
  })

  it('never gates manual generation', async () => {
    const f = await setup()
    onTestFinished(f.close)
    clock(); f.start(); await f.adapter.ready.promise
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(true)
    expect(f.adapter.checks).toHaveLength(1)
  })

  it('generates without any page when onlyWhenVisible is false', async () => {
    const f = await setup({ onlyWhenVisible: false })
    onTestFinished(f.close)
    clock(); f.start(); await f.adapter.ready.promise
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:progress-check/result')
    expect(f.adapter.checks).toHaveLength(1)
  })

  it('accepts a valid report on the Connection channel and rejects a malformed one', async () => {
    const f = await setup({}, new Adapter(), { rpc: true })
    onTestFinished(f.close)
    clock(); f.start(); await f.adapter.ready.promise
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.adapter.checks).toHaveLength(0)
    expect(await f.callRpc('presence', { clientId: 'page', sessionIds: [f.agent.session.id], visible: 'yes' }))
      .toMatchObject({ ok: false, error: { code: 'progress-check/invalid-request' } })
    expect(await f.callRpc('presence', { clientId: 'page', sessionIds: [f.agent.session.id], visible: true }))
      .toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    await f.waitRecords('plugin:progress-check/result')
    expect(f.adapter.checks).toHaveLength(1)
  })

  it('generates through the real Connection route and removes routes with the plugin', async () => {
    const f = await setup({}, new Adapter(), { rpc: true })
    onTestFinished(f.close)
    f.start(); await f.adapter.ready.promise
    expect(await f.callRpc('generate', { sessionId: f.agent.session.id }))
      .toMatchObject({ ok: true, value: { seq: expect.any(Number) } })
    expect(f.adapter.checks).toHaveLength(1)
    await f.plugin.dispose()
    await expect(f.callRpc('presence', { clientId: 'page', sessionIds: [], visible: false }))
      .rejects.toThrow('HTTP 404')
  })

  it('resumes for the deferred work and then keeps a full interval', async () => {
    const adapter = new Adapter(); adapter.calls = 6; adapter.toolRounds = 2
    const f = await setup({}, adapter)
    onTestFinished(f.close)
    clock(); f.start(); await adapter.ready.promise
    await vi.advanceTimersByTimeAsync(120000)
    expect(adapter.checks).toHaveLength(0)
    f.watch()
    await vi.advanceTimersByTimeAsync(0)
    await f.waitRecords('plugin:progress-check/result')
    expect(adapter.checks).toHaveLength(1)
    // The next report still waits a whole interval, measured from the one the user saw.
    await vi.advanceTimersByTimeAsync(59999)
    expect(adapter.checks).toHaveLength(1)
    // New work arrives while the page stays visible.
    adapter.release.resolve(); await f.agent.whenIdle()
    adapter.toolRounds = 4; adapter.release = deferred(); adapter.ready = deferred()
    f.start(); await adapter.ready.promise
    await vi.advanceTimersByTimeAsync(1)
    await f.waitRecords('plugin:progress-check/result', 2)
    expect(adapter.checks).toHaveLength(2)
  })
})

describe('presence registry', () => {
  const page = (clientId: string, sessionIds: string[], visible = true) => ({ clientId, sessionIds, visible })

  it('counts only fresh reports from a page that is on screen', () => {
    const registry = new PresenceRegistry()
    registry.report(page('one', ['session-a']), 1000)
    expect(registry.watched(SessionId('session-a'), 1000)).toBe(true)
    expect(registry.watched(SessionId('session-b'), 1000)).toBe(false)
    expect(registry.watched(SessionId('session-a'), 1000 + PRESENCE_TTL_MS)).toBe(true)
    expect(registry.watched(SessionId('session-a'), 1000 + PRESENCE_TTL_MS + 1)).toBe(false)
  })

  it('replaces one page report and keeps other pages independent', () => {
    const registry = new PresenceRegistry()
    registry.report(page('one', ['session-a']), 0)
    registry.report(page('two', ['session-b']), 0)
    registry.report(page('one', ['session-c']), 10)
    expect(registry.watched(SessionId('session-a'), 10)).toBe(false)
    expect(registry.watched(SessionId('session-c'), 10)).toBe(true)
    expect(registry.watched(SessionId('session-b'), 10)).toBe(true)
    registry.report(page('two', ['session-b'], false), 20)
    expect(registry.watched(SessionId('session-b'), 20)).toBe(false)
  })

  it('forgets every report on clear', () => {
    const registry = new PresenceRegistry()
    registry.report(page('one', ['session-a']), 0)
    registry.clear()
    expect(registry.watched(SessionId('session-a'), 0)).toBe(false)
  })
})
