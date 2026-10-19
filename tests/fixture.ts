import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, isAgentLoopRequest, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Progress from '../src/index.ts'

export const modelReport = { progress: ['正在验证会话保存修复。', '下一步验证旧格式读取和恢复。'], uncertainties: ['旧格式应统一迁移还是保留独立兼容层，目前无法确定。'], userActions: ['请并行确认仍在使用的旧格式版本范围，帮助缩小兼容验证范围。'] }
export const report = { ...modelReport, progress: modelReport.progress.join('\n') }
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
export function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 42, outputTokens: 20, cacheReadTokens: 36 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
export function toolChunks(count: number, prefix = 'call'): StreamChunk[] {
  const chunks: StreamChunk[] = Array.from({ length: count }, (_, index) => ({
    type: 'block-end' as const, index, block: { type: 'tool-call' as const, id: ToolCallId(`${prefix}-${index}`), name: 'echo', arguments: '{}' },
  }))
  return [...chunks, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
export async function untilReleased(promise: Promise<void>, signal: AbortSignal | undefined) {
  if (signal?.aborted) return
  let abort!: () => void
  await Promise.race([promise, new Promise<void>(resolve => { abort = resolve; signal?.addEventListener('abort', abort, { once: true }) })])
  signal?.removeEventListener('abort', abort)
}
export class Adapter extends LlmAdapter {
  main: GenerateOptions[] = []
  checks: GenerateOptions[] = []
  ready = deferred()
  release = deferred()
  checkRelease: ReturnType<typeof deferred> | undefined
  checkHolds = new Map<number, ReturnType<typeof deferred>>()
  prepareFailure: Error | undefined
  responseFailure: Error | undefined
  answer = textChunks(JSON.stringify(modelReport))
  answers: StreamChunk[][] = []
  calls = 6
  /**
   * Leading main requests per Session that answer with tool calls. Raising it
   * mid-test produces another batch of work for the next cadence interval.
   */
  toolRounds = 1
  activeChecks = 0
  peakChecks = 0
  private mainCounts = new Map<string, number>()
  private mainWaiters: { count: number; resolve(): void }[] = []
  private checkWaiters: { count: number; resolve(): void }[] = []
  waitForChecks(count: number): Promise<void> {
    if (this.checks.length >= count) return Promise.resolve()
    return new Promise(resolve => this.checkWaiters.push({ count, resolve }))
  }
  waitForMain(count: number): Promise<void> {
    if (this.main.length >= count) return Promise.resolve()
    return new Promise(resolve => this.mainWaiters.push({ count, resolve }))
  }
  override async resolveModel(provider: string, model: string) {
    if (this.prepareFailure !== undefined) throw this.prepareFailure
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!isAgentLoopRequest(options)) {
      this.checks.push(options)
      for (const waiter of this.checkWaiters) if (this.checks.length >= waiter.count) waiter.resolve()
      this.activeChecks++
      this.peakChecks = Math.max(this.peakChecks, this.activeChecks)
      try {
        const hold = this.checkHolds.get(this.checks.length) ?? this.checkRelease
        if (hold !== undefined) await untilReleased(hold.promise, options.signal)
        if (!options.signal?.aborted) {
          yield* this.answers.shift() ?? this.answer
          if (this.responseFailure !== undefined) throw this.responseFailure
        }
      } finally {
        this.activeChecks--
      }
      return
    }
    this.main.push(options)
    for (const waiter of this.mainWaiters) if (this.main.length >= waiter.count) waiter.resolve()
    const count = (this.mainCounts.get(options.sessionId ?? '') ?? 0) + 1
    this.mainCounts.set(options.sessionId ?? '', count)
    if (count <= this.toolRounds) { yield* toolChunks(this.calls); return }
    this.ready.resolve()
    await untilReleased(this.release.promise, options.signal)
    if (!options.signal?.aborted) yield* textChunks('Main task finished.')
  }
}
export async function setup(
  config: Partial<Progress.Config> = {}, adapter = new Adapter(), options: { rpc?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-progress-test-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'Read a fixture', parameters: {}, async execute() { return [{ type: 'text', text: 'fixture read' }] } }))
  let handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined
  if (options.rpc === true) {
    // Minimal Connection face: the plugin registers its channel handler against it.
    ctx.provide('connection', {
      rpc: {
        handle: (_channel: string, registered: typeof handler) => {
          handler = registered
          return async () => {}
        },
      },
    } as never)
    ctx.provide('webServer', {} as never)
  }
  const plugin = await ctx.plugin(Progress, { ...Progress.Config({}), ...config })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('progress-test'), { provider: 'mock', model: 'fixture', reasoningEffort: ReasoningEffortId('high'), maxTokens: 2000 })
  const handle = await ctx.sessionPersistence.open(agent.session.id, 'read')
  const events: SessionEvent[] = []
  ctx.on('session/event', (_session, event) => { events.push(event) })
  const start = () => agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '修复会话保存问题。' }] }))
  const waitRecords = async (type: string, count = 1) => {
    if (events.filter(event => event.type === type).length < count) await new Promise<void>(resolve => {
      const off = ctx.on('session/event', () => {
        if (events.filter(event => event.type === type).length >= count) { off(); resolve() }
      })
    })
    await ctx.sessions.flush(agent.session)
  }
  const close = async () => {
    for (const current of ctx.agents.list()) current.cancel({ kind: 'disposed' })
    await Promise.all(ctx.agents.list().map(current => current.whenIdle()))
    await ctx.fiber.dispose()
    await handle.close()
    await rm(root, { recursive: true, force: true })
  }
  /**
   * Report what the one fixture page shows, replacing its previous report.
   * @param visible - whether that page is on screen.
   * @param sessionIds - Sessions it shows; the fixture Session by default.
   */
  const watch = (visible = true, ...sessionIds: SessionId[]) => {
    ctx.progressCheck.reportPresence({
      clientId: 'fixture-page', visible,
      sessionIds: sessionIds.length === 0 ? [agent.session.id] : sessionIds,
    })
  }
  /**
   * Call the plugin's registered Connection channel, waiting for the
   * registration that `ctx.inject(['connection', 'webServer'])` defers.
   * @param endpoint - channel endpoint name.
   * @param payload - untrusted request payload.
   * @returns the handler's result.
   */
  const callRpc = async (endpoint: string, payload: unknown): Promise<unknown> => {
    for (let tick = 0; tick < 10 && handler === undefined; tick++) await Promise.resolve()
    if (handler === undefined) throw new Error('the fixture Connection channel was never registered')
    return handler(endpoint, payload, new AbortController().signal)
  }
  return { ctx, root, agent, adapter, events, plugin, start, close, handle, waitRecords, harness, watch, callRpc }
}
