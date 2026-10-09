import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { readResult } from '../src/records.ts'
import { progressDefinition } from '../src/client/definition.ts'
import { Adapter, deferred, modelReport, report, setup, textChunks, toolChunks } from './fixture.ts'

afterEach(() => vi.useRealTimers())
function clock() { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) }
async function started(calls = 6, config = {}) {
  const adapter = new Adapter(); adapter.calls = calls
  const f = await setup(config, adapter)
  onTestFinished(f.close)
  clock(); f.start(); await adapter.ready.promise
  return f
}

describe('running-session progress checks', () => {
  it('uses the saved DSH language and reads changes for the next report', async () => {
    const f = await started()
    let preference = 'zh'
    // This service fixture supplies only the descriptor reader used by the plugin.
    f.ctx.provide('settings', { describe: () => [{ ns: 'locale', value: { preference } }] })
    await vi.advanceTimersByTimeAsync(60000)
    await f.waitRecords('plugin:progress-check/result')
    const first = f.adapter.checks[0]!.messages.at(-1)!.content[0]!
    expect(first).toMatchObject({ type: 'text', text: expect.stringContaining('DSH output language is "zh"') })
    preference = 'en'
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(true)
    const second = f.adapter.checks[1]!.messages.at(-1)!.content[0]!
    expect(second).toMatchObject({ type: 'text', text: expect.stringContaining('DSH output language is "en"') })
    expect(second.type === 'text' && /[\u3400-\u9fff]/u.test(second.text)).toBe(false)
    const saved = (await f.handle.read()).events.flatMap(event => {
      const record = pluginRecordOf(event)
      return record?.type === 'plugin:progress-check/request' ? [record.data.request.messages.at(-1)] : []
    })
    expect(saved).toEqual(f.adapter.checks.map(request => request.messages.at(-1)))
  })

  it('keeps the selected language in format retries and supports registered language tags', async () => {
    const f = await started()
    f.ctx.provide('settings', { describe: () => [{ ns: 'locale', value: { preference: 'ja' } }] })
    f.adapter.answers = [textChunks('invalid JSON'), textChunks(JSON.stringify(modelReport))]
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(true)
    expect(f.adapter.checks).toHaveLength(2)
    for (const request of f.adapter.checks) {
      expect(request.messages.at(-1)!.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('DSH output language is "ja"') })
    }
    expect(f.adapter.checks[1]!.messages.at(-1)!.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('The previous response could not be parsed') })
  })

  it('uses the conversation language when no explicit DSH selection is saved', async () => {
    const f = await started()
    f.ctx.provide('settings', { describe: () => [{ ns: 'locale', value: {} }] })
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(true)
    expect(f.adapter.checks[0]!.messages.at(-1)!.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining("Use the user's language from the conversation") })
  })

  it('generates on demand before the timer and below the call threshold without changing the main request', async () => {
    const f = await started(1)
    const before = f.agent.session.deriveMessages()
    const result = await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(f.adapter.checks).toHaveLength(1)
    expect(f.agent.session.deriveMessages()).toEqual(before)
    expect(f.events.find(event => readResult(event) !== undefined)?.seq).toBe(result.ok ? result.seq : undefined)
    const saved = await f.handle.read()
    expect(saved.events.some(event => readResult(event) !== undefined)).toBe(true)
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(true)
    expect(f.adapter.checks).toHaveLength(2)
  })

  it('joins an automatic check and does not cancel it when the joining caller leaves', async () => {
    const f = await started()
    f.adapter.checkRelease = deferred()
    await vi.advanceTimersByTimeAsync(60000)
    await f.adapter.waitForChecks(1)
    const controller = new AbortController()
    const first = f.ctx.progressCheck.generate(f.agent.session.id, controller.signal)
    const second = f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)
    controller.abort()
    expect(f.adapter.checks[0]?.signal?.aborted).toBe(false)
    f.adapter.checkRelease.resolve()
    expect(await first).toEqual(await second)
    expect((await first).ok).toBe(true)
    expect(f.adapter.checks).toHaveLength(1)
  })

  it('times out a manual request waiting for complete tool results', async () => {
    const f = await setup({ timeoutMs: 50 })
    onTestFinished(f.close)
    const toolEntered = deferred()
    const toolsReleased = deferred()
    f.ctx.on('tools/pre-execute', async (_exec, next) => {
      toolEntered.resolve()
      await toolsReleased.promise
      return next()
    }, { global: true })
    try {
      clock(); f.start(); await toolEntered.promise
      const operation = f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(50)
      expect(await operation).toMatchObject({ ok: false, message: 'progress-check timed out' })
      expect(f.adapter.checks).toHaveLength(0)
    } finally {
      toolsReleased.resolve()
    }
  })

  it('cancels queued and running manual checks on unload and removes the manual service', async () => {
    const f = await started(1, { maxConcurrent: 1 })
    const second = await f.harness.create(SessionId('manual-second'), { provider: 'mock', model: 'fixture' })
    second.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Another task' }] }))
    await f.adapter.waitForMain(4)
    f.adapter.checkRelease = deferred()
    const running = f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)
    await f.adapter.waitForChecks(1)
    const queued = f.ctx.progressCheck.generate(second.session.id, new AbortController().signal)
    await f.plugin.dispose()
    expect((await running).ok).toBe(false)
    expect((await queued).ok).toBe(false)
    expect(f.adapter.activeChecks).toBe(0)
    expect(f.adapter.checks).toHaveLength(1)
    expect(f.ctx.get('progressCheck')).toBeUndefined()
  })

  it('refuses idle and unknown sessions without making a model call', async () => {
    const f = await setup()
    onTestFinished(f.close)
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(false)
    expect((await f.ctx.progressCheck.generate(SessionId('missing'), new AbortController().signal)).ok).toBe(false)
    expect(f.adapter.checks).toHaveLength(0)
  })

  it('preserves the main prefix and persists an independent, replayable report', async () => {
    const f = await started()
    const before = f.agent.session.deriveMessages()
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.adapter.checks).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await f.ctx.sessions.flush(f.agent.session)
    await vi.advanceTimersByTimeAsync(0)
    await f.waitRecords('plugin:progress-check/result')
    const resultEvent = f.events.find(event => readResult(event) !== undefined)
    expect(resultEvent).toBeDefined()
    expect(readResult(resultEvent!)?.report).toEqual(report)
    expect(f.adapter.checks).toHaveLength(1)
    const auxiliary = f.adapter.checks[0]!
    expect(auxiliary.messages.at(-1)).toMatchSnapshot()
    const main = f.adapter.main.at(-1)!
    expect(auxiliary.messages.slice(0, -1)).toEqual(main.messages)
    expect(auxiliary.tools).toEqual(main.tools)
    expect(auxiliary.toolHistory).toEqual(main.toolHistory)
    expect(auxiliary).toMatchObject({ provider: main.provider, model: main.model, reasoningEffort: main.reasoningEffort, maxTokens: main.maxTokens })
    expect(auxiliary.purpose).toBeUndefined()
    expect(f.agent.session.deriveMessages()).toEqual(before)
    await f.ctx.sessions.flush(f.agent.session)
    const { events } = await f.handle.read()
    const restored = Session.create(SessionId('progress-test'), events, f.handle.header, f.handle.inheritedEventCount)
    expect(restored.deriveMessages()).toEqual(before)
    const saved = events.find(event => readResult(event) !== undefined)!
    expect(progressDefinition.match(saved)).toMatchObject({ role: 'start' })
    expect(saved).toMatchObject({ ignorable: true })
    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(Jsonl, { root: f.root, compression: 'none' })
    const reopened = await reader.sessionPersistence.open(f.agent.session.id, 'read')
    expect((await reopened.read()).events.find(event => readResult(event) !== undefined)).toEqual(saved)
    await reopened.close()
    await reader.fiber.dispose()
    await vi.advanceTimersByTimeAsync(60000)
    await f.ctx.sessions.flush(f.agent.session)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.adapter.checks).toHaveLength(1)
    f.adapter.release.resolve(); await f.agent.whenIdle()
  })

  it('requires strictly more than the configured number of calls', async () => {
    const f = await started(5)
    await vi.advanceTimersByTimeAsync(600000)
    expect(f.adapter.checks).toHaveLength(0)
  })

  it('accumulates only running time across idle periods', async () => {
    const f = await started()
    await vi.advanceTimersByTimeAsync(20000)
    f.adapter.release.resolve(); await f.agent.whenIdle()
    await vi.advanceTimersByTimeAsync(900000)
    expect(f.adapter.checks).toHaveLength(0)
    f.adapter.release = deferred(); f.adapter.ready = deferred()
    f.start(); await f.adapter.ready.promise
    await vi.advanceTimersByTimeAsync(39999)
    expect(f.adapter.checks).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await f.ctx.sessions.flush(f.agent.session)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.adapter.checks).toHaveLength(1)
  })

  it('retries invalid JSON and invalid fields, preserving each attempt for debugging', async () => {
    const f = await started()
    const before = f.agent.session.deriveMessages()
    const badJson = 'not JSON'
    const badFields = JSON.stringify({ ...modelReport, userActions: '错误类型' })
    f.adapter.answers = [textChunks(badJson), textChunks(badFields)]
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(true)
    expect(f.adapter.checks).toHaveLength(3)
    expect(f.agent.session.deriveMessages()).toEqual(before)
    const saved = (await f.handle.read()).events.map(pluginRecordOf)
    const requests = saved.filter(record => record?.type === 'plugin:progress-check/request').map(record => record.data)
    const responses = saved.filter(record => record?.type === 'plugin:progress-check/response').map(record => record.data)
    const failures = saved.filter(record => record?.type === 'plugin:progress-check/failure').map(record => record.data)
    expect(requests.map(record => record.attempt)).toEqual([1, 2, 3])
    expect(responses.map(record => record.text)).toEqual([badJson, badFields, JSON.stringify(modelReport)])
    expect(responses[0]?.chunks).toEqual(textChunks(badJson))
    expect(failures.map(record => ({ attempt: record.attempt, stage: record.stage, retryable: record.retryable })))
      .toEqual([{ attempt: 1, stage: 'parse', retryable: true }, { attempt: 2, stage: 'parse', retryable: true }])
    expect(failures.every(record => record.message.length > 0)).toBe(true)
    expect(new Set([...requests, ...responses, ...failures].map(record => record.id)).size).toBe(1)
    expect(saved.filter(record => record?.type === 'plugin:progress-check/result')).toHaveLength(1)
    for (const [index, request] of requests.entries()) {
      const { signal: _signal, ...sent } = f.adapter.checks[index]!
      expect(request.request).toEqual(sent)
      expect(request.prepared).toBe(true)
      expect(request.request.messages.slice(0, -1)).toEqual(f.adapter.main.at(-1)!.messages)
    }
    expect(requests[1]?.request.messages.at(-1)).toMatchSnapshot()
  })

  it('stops after three format retries and retains the watermark for the next interval', async () => {
    const f = await started()
    f.adapter.answer = textChunks('not JSON')
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(false)
    expect(f.adapter.checks).toHaveLength(4)
    expect(f.events.filter(event => event.type === 'plugin:progress-check/failure')).toHaveLength(4)
    expect(f.events.some(event => readResult(event) !== undefined)).toBe(false)
    f.adapter.answer = textChunks(JSON.stringify(modelReport))
    await vi.advanceTimersByTimeAsync(59999)
    expect(f.adapter.checks).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1)
    await f.waitRecords('plugin:progress-check/result')
    expect(f.adapter.checks).toHaveLength(5)
  })

  it('cancels between attempts without sending another request', async () => {
    const f = await started()
    f.adapter.answer = textChunks('not JSON')
    const controller = new AbortController()
    f.ctx.on('session/event', (_session, event) => {
      if (event.type === 'plugin:progress-check/failure') controller.abort()
    })
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, controller.signal)).ok).toBe(false)
    expect(f.adapter.checks).toHaveLength(1)
    expect(f.adapter.activeChecks).toBe(0)
  })

  it('can disable immediate format retries while keeping the failed response', async () => {
    const f = await started(6, { maxParseRetries: 0 })
    f.adapter.answer = textChunks('not JSON')
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(false)
    expect(f.adapter.checks).toHaveLength(1)
    const saved = (await f.handle.read()).events.map(pluginRecordOf)
    expect(saved.find(record => record?.type === 'plugin:progress-check/response')?.data.text).toBe('not JSON')
  })

  it('keeps partial output and the provider error without retrying a failed stream', async () => {
    const f = await started()
    const partial = textChunks('{"progress":').slice(0, 1)
    f.adapter.answer = partial
    f.adapter.responseFailure = new Error('fixture stream disconnected')
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(false)
    expect(f.adapter.checks).toHaveLength(1)
    expect(f.adapter.activeChecks).toBe(0)
    const saved = (await f.handle.read()).events.map(pluginRecordOf)
    const finish = { kind: 'error', failure: { code: 'UNKNOWN', message: 'fixture stream disconnected' } }
    expect(saved.find(record => record?.type === 'plugin:progress-check/response')?.data)
      .toMatchObject({ text: '{"progress":', chunks: [...partial, { type: 'finish', reason: finish }], finish, truncated: false })
    expect(saved.find(record => record?.type === 'plugin:progress-check/failure')?.data)
      .toMatchObject({ stage: 'response', retryable: false, message: 'progress-check did not finish normally (error)', stack: expect.stringContaining('progress-check did not finish normally (error)') })
  })

  it('marks oversized responses and retains only chunks within the byte limit', async () => {
    const f = await started(6, { maxResponseBytes: 160 })
    const partial = textChunks('{"progress":').slice(0, 1)
    f.adapter.answer = [...partial, ...textChunks('x'.repeat(200))]
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(false)
    expect(f.adapter.checks).toHaveLength(1)
    const saved = (await f.handle.read()).events.map(pluginRecordOf)
    const response = saved.find(record => record?.type === 'plugin:progress-check/response')?.data
    expect(response).toMatchObject({ text: '{"progress":', chunks: partial, truncated: true })
    expect(response?.receivedBytes).toBeGreaterThan(160)
    expect(saved.find(record => record?.type === 'plugin:progress-check/failure')?.data)
      .toMatchObject({ stage: 'response', retryable: false, message: 'progress-check response exceeded maxResponseBytes' })
  })

  it('shares one timeout across retries and drains the interrupted attempt', async () => {
    const f = await started()
    f.adapter.answers = [textChunks('not JSON')]
    f.adapter.checkHolds.set(2, deferred())
    const operation = f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)
    await f.adapter.waitForChecks(2)
    await vi.advanceTimersByTimeAsync(120000)
    expect((await operation).ok).toBe(false)
    expect(f.adapter.checks).toHaveLength(2)
    expect(f.adapter.activeChecks).toBe(0)
    const failures = (await f.handle.read()).events.map(pluginRecordOf).filter(record => record?.type === 'plugin:progress-check/failure')
    expect(failures.at(-1)?.data).toMatchObject({ attempt: 2, canceled: true })
  })

  it('logs the candidate request when model preparation fails without retrying it', async () => {
    const f = await started()
    f.adapter.prepareFailure = new Error('fixture preparation failed')
    expect((await f.ctx.progressCheck.generate(f.agent.session.id, new AbortController().signal)).ok).toBe(false)
    expect(f.adapter.checks).toHaveLength(0)
    const saved = (await f.handle.read()).events.map(pluginRecordOf)
    const requests = saved.filter(record => record?.type === 'plugin:progress-check/request')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.data).toMatchObject({ attempt: 1, prepared: false, request: { provider: 'mock', model: 'fixture' } })
    expect(saved.find(record => record?.type === 'plugin:progress-check/failure')?.data)
      .toMatchObject({ stage: 'prepare', retryable: false, message: 'fixture preparation failed' })
  })

  it('never executes tools returned by the status model', async () => {
    const f = await started()
    f.adapter.answer = toolChunks(1, 'forbidden')
    await vi.advanceTimersByTimeAsync(60000)
    await f.ctx.sessions.flush(f.agent.session)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.events.filter(event => event.type === 'tool/call')).toHaveLength(6)
    expect(f.events.some(event => readResult(event) !== undefined)).toBe(false)
  })

  it('aborts a pending check at idle and waits for it on plugin unload', async () => {
    const f = await started()
    f.adapter.checkRelease = deferred()
    await vi.advanceTimersByTimeAsync(60000)
    await f.ctx.sessions.flush(f.agent.session)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.adapter.checks).toHaveLength(1)
    f.adapter.release.resolve(); await f.agent.whenIdle()
    await f.plugin.dispose()
    expect(f.adapter.checks[0]?.signal?.aborted).toBe(true)
    expect(f.events.some(event => readResult(event) !== undefined)).toBe(false)
    await vi.advanceTimersByTimeAsync(900000)
    expect(f.adapter.checks).toHaveLength(1)
  })

  it('times out a stuck check without consuming its watermark', async () => {
    const f = await started()
    f.adapter.checkRelease = deferred()
    await vi.advanceTimersByTimeAsync(60000)
    await f.ctx.sessions.flush(f.agent.session)
    await vi.advanceTimersByTimeAsync(120000)
    await f.ctx.sessions.flush(f.agent.session)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.adapter.checks[0]?.signal?.aborted).toBe(true)
    expect(f.events.some(event => readResult(event) !== undefined)).toBe(false)
    f.adapter.checkRelease = undefined
    await vi.advanceTimersByTimeAsync(60000)
    await f.ctx.sessions.flush(f.agent.session)
    await vi.advanceTimersByTimeAsync(0)
    await f.waitRecords('plugin:progress-check/result')
    expect(f.events.some(event => readResult(event) !== undefined)).toBe(true)
  })
  it('limits concurrent checks across multiple sessions and drains queued work', async () => {
    const f = await started(6, { maxConcurrent: 1 })
    f.adapter.checkRelease = deferred()
    for (const id of ['second', 'third']) {
      const agent = await f.harness.create(SessionId(id), { provider: 'mock', model: 'fixture' })
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Another task' }] }))
    }
    await f.adapter.waitForMain(6)
    await vi.advanceTimersByTimeAsync(60000)
    await f.ctx.sessions.flush(f.agent.session)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.adapter.checks).toHaveLength(1)
    f.adapter.checkRelease.resolve()
    await f.waitRecords('plugin:progress-check/result', 3)
    expect(f.adapter.checks).toHaveLength(3)
    expect(f.adapter.peakChecks).toBe(1)
  })

  it('waits until every tool result is included in a complete main request', async () => {
    const f = await setup()
    onTestFinished(f.close)
    const toolEntered = deferred()
    const toolsReleased = deferred()
    f.ctx.on('tools/pre-execute', async (_exec, next) => {
      toolEntered.resolve()
      await toolsReleased.promise
      return next()
    }, { global: true })
    clock(); f.start(); await toolEntered.promise
    await vi.advanceTimersByTimeAsync(60000)
    expect(f.adapter.checks).toHaveLength(0)
    toolsReleased.resolve()
    await f.adapter.ready.promise
    await f.waitRecords('plugin:progress-check/result')
    expect(f.adapter.checks).toHaveLength(1)
    expect(f.adapter.checks[0]?.messages.filter(message => message.role === 'tool')).toHaveLength(6)
  })

})
