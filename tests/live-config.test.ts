/** Volatile configuration edits committed by the Settings service while the plugin runs. */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Adapter, liveConfig, setup } from './fixture.ts'

afterEach(() => { vi.useRealTimers() })
function clock() { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) }

describe('live configuration changes', () => {
  it('re-arms automatic reports when the interval is shortened', async () => {
    const live = liveConfig()
    const adapter = new Adapter(); adapter.toolRounds = 5
    const f = await setup({}, adapter, { live })
    onTestFinished(f.close)
    f.watch()
    clock()
    f.start()
    await adapter.ready.promise
    await vi.advanceTimersByTimeAsync(59999)
    expect(adapter.checks).toHaveLength(0)
    live.set('intervalMs', 1000)
    f.volatileUpdate()
    await vi.advanceTimersByTimeAsync(1000)
    await f.waitRecords('plugin:progress-check/result')
    expect(adapter.checks).toHaveLength(1)
  })

  it('releases a due report when visibility gating is switched off', async () => {
    const live = liveConfig({ intervalMs: 1000 })
    const adapter = new Adapter(); adapter.toolRounds = 5
    const f = await setup({}, adapter, { live })
    onTestFinished(f.close)
    clock()
    f.start()
    await adapter.ready.promise
    // The timer fires with nobody looking, so the due report waits for a viewer.
    await vi.advanceTimersByTimeAsync(1000)
    expect(adapter.checks).toHaveLength(0)
    live.set('onlyWhenVisible', false)
    f.volatileUpdate()
    await f.waitRecords('plugin:progress-check/result')
    expect(adapter.checks).toHaveLength(1)
  })

  it('attaches existing subagent sessions when subagent reports are enabled', async () => {
    const live = liveConfig({ intervalMs: 1000 })
    const f = await setup({}, new Adapter(), { live })
    onTestFinished(f.close)
    const { agent } = await f.ctx.agents.create({
      sessionId: SessionId('live-subagent'), meta: { origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'fixture' },
    })
    f.watch(true, agent.session.id)
    clock()
    // The existing session joins the scheduler as soon as the switch moves.
    live.set('includeSubagents', true)
    f.volatileUpdate()
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Child task' }] }))
    await f.adapter.ready.promise
    await vi.advanceTimersByTimeAsync(1000)
    await f.waitRecords('plugin:progress-check/result')
    expect(f.adapter.checks).toHaveLength(1)
  })

  it('detaches subagent sessions when subagent reports are switched off', async () => {
    const live = liveConfig({ includeSubagents: true })
    const f = await setup({}, new Adapter(), { live })
    onTestFinished(f.close)
    const { agent } = await f.ctx.agents.create({
      sessionId: SessionId('detached-subagent'), meta: { origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'fixture' },
    })
    f.watch(true, agent.session.id)
    clock()
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Child task' }] }))
    await f.adapter.ready.promise
    live.set('includeSubagents', false)
    f.volatileUpdate()
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.adapter.checks).toHaveLength(0)
  })

  it('owns its configuration page instead of an automatically generated one', async () => {
    const configure = vi.fn(() => () => {})
    const f = await setup({}, new Adapter(), { live: liveConfig() })
    onTestFinished(f.close)
    f.ctx.provide('settings', { describe: () => [], configure })
    await vi.waitFor(() => {
      expect(configure).toHaveBeenCalledWith({ auto: false }, f.plugin)
    })
  })
})
