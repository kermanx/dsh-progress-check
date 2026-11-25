/** Periodic auxiliary progress checks for running agents, with durable Session records. */
import { randomUUID } from 'node:crypto'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: `loader/volatile-update`, emitted after a Settings edit commits
// into this plugin's running configuration references.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { LOCALE_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-client-locale'
import { createQuestion } from './prompt.ts'
import { progressProjection } from './projection.ts'
import { PresenceRegistry } from './presence.ts'
import { modelReportSchema } from './records.ts'
import type { CheckId, FailureStage, StoredRequest } from './records.ts'
import type { ProgressOutcome } from './types.ts'
import { GENERATE_METHOD, PRESENCE_METHOD, generateRequestSchema, presenceReportSchema } from './protocol.ts'
import { registerProgressRpc } from './rpc.ts'

/**
 * Deployment-owned cadence, resource limits, and agent selection. Every field
 * is volatile, so the Settings service can project the form on the Plugins
 * page and a saved edit commits into the running references without a reload.
 */
export interface Config {
  intervalMs: Volatile<number>
  intervalSteps: Volatile<number>
  maxConcurrent: Volatile<number>
  timeoutMs: Volatile<number>
  maxResponseBytes: Volatile<number>
  maxParseRetries: Volatile<number>
  includeSubagents: Volatile<boolean>
  onlyWhenVisible: Volatile<boolean>
  refreshOnTurnEnd: Volatile<boolean>
}
/** Plain values the schema accepts for one configuration layer. */
export type ConfigValues = { [K in keyof Config]: Config[K] extends Volatile<infer V> ? V : never }
/** Validated defaults; both minimum intervals must be met for automatic checks. */
export const Config = z.object({
  intervalMs: z.number().min(1).step(1).default(60000).volatile(),
  intervalSteps: z.number().min(1).step(1).default(5).volatile(),
  maxConcurrent: z.number().min(1).step(1).default(1).volatile(),
  timeoutMs: z.number().min(1).step(1).default(120000).volatile(),
  maxResponseBytes: z.number().min(1).step(1).default(262144).volatile(),
  maxParseRetries: z.number().min(0).max(3).step(1).default(3).volatile(),
  includeSubagents: z.boolean().default(false).volatile(),
  onlyWhenVisible: z.boolean().default(true).volatile(),
  refreshOnTurnEnd: z.boolean().default(false).volatile(),
})
/** Services whose lifetime owns the scheduler. Persistence is verified by awaited flushes. */
export const inject = ['agents', 'sessions', 'sessionProjections', 'llm']

interface Snapshot {
  request: StoredRequest
  signal: AbortSignal | undefined
  toolCount: number
  actionToolCount: number
  stepCount: number
  seq: number
}
type RequestTemplate = Omit<StoredRequest, 'messages' | 'toolHistory'>
interface Work {
  agent: Agent
  remaining: number
  startedAt: number | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  due: boolean
  turnEndDue: boolean
  template: RequestTemplate | undefined
  snapshot: Snapshot | undefined
  operation: Operation | undefined
  covered: number
  coveredTools: number
}
interface Operation {
  controller: AbortController
  phase: 'queued' | 'running'
  reason: 'periodic' | 'turn-end' | 'manual'
  stepCount: number
  promise: Promise<ProgressOutcome>
  resolve(value: ProgressOutcome): void
  cleanup(): void
}

/**
 * Attach background checks to all live agents and unwind timers and calls on removal.
 * Awaits projection registration before exposing reads or operations that depend on it.
 * @param ctx - plugin-owned context.
 * @param config - validated configuration.
 * @returns when the projection is registered and the schedulers are listening.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const localeSettings = zod.object({ preference: zod.string().optional() })
  const outputLocale = () => {
    const descriptor = ctx.get('settings')?.describe().find(form => form.ns === LOCALE_SETTINGS_NAMESPACE)
    return descriptor === undefined ? undefined : localeSettings.parse(descriptor.value).preference
  }
  const work = new Map<SessionId, Work>()
  const presence = new PresenceRegistry()
  let stopped = false
  let active = 0
  const pending = new Set<Promise<ProgressOutcome>>()
  // Retain the ready handle: the registry-level read is deprecated, and the
  // handle keeps folding even if the unit later leaves the live drive.
  const projection = await ctx.sessionProjections.register(progressProjection)

  const stateOf = (agent: Agent) => projection.stateOf(agent.session)
  const alive = (entry: Work) => !stopped && work.get(entry.agent.session.id) === entry
  const running = (entry: Work) => alive(entry) && entry.agent.status === 'running'
  const eligible = (entry: Work, reason: Operation['reason']) => reason === 'periodic' ? running(entry) : alive(entry)
  // A card is only worth a model call while a foreground page shows the Session.
  const watched = (entry: Work) => !config.onlyWhenVisible.get() || presence.watched(entry.agent.session.id)
  const stopTimer = (entry: Work) => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.startedAt !== undefined) entry.remaining = Math.max(0, entry.remaining - (performance.now() - entry.startedAt))
    entry.startedAt = undefined
  }
  const terminate = (entry: Work) => {
    stopTimer(entry)
    entry.due = false
    entry.turnEndDue = false
    entry.operation?.controller.abort(new Error('agent stopped working'))
    entry.snapshot = undefined
  }
  const pause = (entry: Work) => {
    stopTimer(entry)
    if (entry.operation?.reason === 'periodic') entry.operation.controller.abort(new Error('agent stopped working'))
    if (!entry.turnEndDue && entry.operation?.reason !== 'turn-end' && entry.operation?.reason !== 'manual') {
      entry.snapshot = undefined
    }
  }
  const buildPostTurnRequest = (entry: Work): StoredRequest | undefined => {
    const { session } = entry.agent
    const messages = session.deriveMessages()
    if (messages.length === 0) return undefined
    if (entry.template !== undefined) {
      return {
        ...structuredClone(entry.template),
        messages: structuredClone(messages),
        toolHistory: structuredClone(session.toolHistory()),
      }
    }
    const header = session.requestHeader()
    if (header === undefined) return undefined
    return {
      ...structuredClone(header.config),
      messages: structuredClone(messages),
      toolHistory: structuredClone(session.toolHistory()),
      ...header.tools !== undefined ? { tools: structuredClone(header.tools) } : {},
      sessionId: session.id,
    }
  }
  const arm = (entry: Work) => {
    if (!running(entry) || entry.timer !== undefined || entry.due || entry.operation !== undefined) return
    entry.startedAt = performance.now()
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      entry.startedAt = undefined
      entry.remaining = 0
      entry.due = true
      pump()
    }, entry.remaining)
    entry.timer.unref?.()
  }
  const reset = (entry: Work) => {
    entry.due = false
    entry.remaining = config.intervalMs.get()
    arm(entry)
  }
  const attach = (agent: Agent) => {
    if (work.has(agent.session.id) || (!config.includeSubagents.get() && agent.session.header.origin === 'subagent')) return
    const state = stateOf(agent)
    const entry: Work = { agent, remaining: config.intervalMs.get(), startedAt: undefined, timer: undefined, due: false, turnEndDue: false, template: undefined, snapshot: undefined, operation: undefined, covered: state.covered, coveredTools: state.coveredActionTools }
    work.set(agent.session.id, entry)
    arm(entry)
  }
  const flush = async (entry: Work) => {
    if (!await ctx.sessions.flush(entry.agent.session)) throw new Error('progress-check requires durable session persistence')
  }
  const check = async (entry: Work, snapshot: Snapshot, controller: AbortController, reason: Operation['reason']): Promise<ProgressOutcome> => {
    const id = randomUUID() as CheckId
    const { session } = entry.agent
    const abort = () => controller.abort(snapshot.signal?.reason)
    snapshot.signal?.addEventListener('abort', abort, { once: true })
    if (snapshot.signal?.aborted) abort()
    try {
      for (let attempt = 1; ; attempt++) {
        const assembler = new BlockAssembler()
        const chunks: StreamChunk[] = []
        let finished = false
        let bytes = 0
        let truncated = false
        let requestRecorded = false
        let responseRecorded = false
        let preparedConfig = false
        let stage: FailureStage = 'prepare'
        const previousLinks = stateOf(entry.agent).latest?.report.links
        let request: StoredRequest = {
          ...snapshot.request,
          messages: [...snapshot.request.messages, { role: 'user', content: [{
            type: 'text', text: createQuestion(outputLocale(), attempt > 1, reason === 'turn-end' ? 'turn-end' : 'running', previousLinks),
          }] }],
        }
        const recordRequest = () => {
          appendPluginRecord(session, 'plugin:progress-check/request', {
            version: 1, id, attempt, prepared: preparedConfig, sessionId: session.id,
            coveredToolCount: snapshot.toolCount, coveredStepCount: snapshot.stepCount, contextSeq: snapshot.seq, request,
          })
          requestRecorded = true
        }
        const recordResponse = () => {
          let blocks: ContentBlock[] = []
          let assemblyError: string | undefined
          try {
            blocks = assembler.blocks()
          } catch (error: unknown) {
            assemblyError = error instanceof Error ? error.message : String(error)
          }
          appendPluginRecord(session, 'plugin:progress-check/response', {
            version: 1, id, attempt, sessionId: session.id,
            text: blocks.filter(block => block.type === 'text').map(block => block.text).join(''),
            chunks, blocks, receivedBytes: bytes, truncated,
            ...assemblyError === undefined ? {} : { assemblyError },
            ...finished ? { finish: assembler.finish } : {},
            ...assembler.usage === undefined ? {} : { usage: assembler.usage },
          })
          responseRecorded = true
        }
        try {
          controller.signal.throwIfAborted()
          const prepared = await ctx.llm.prepareCall(request, controller.signal)
          request = { ...request, ...prepared.config }
          preparedConfig = true
          controller.signal.throwIfAborted()
          stage = 'request'
          recordRequest()
          await flush(entry)
          controller.signal.throwIfAborted()
          stage = 'response'
          for await (const chunk of prepared.stream({ ...request, signal: controller.signal })) {
            controller.signal.throwIfAborted()
            bytes += Buffer.byteLength(JSON.stringify(chunk), 'utf8')
            if (bytes > config.maxResponseBytes.get()) {
              truncated = true
              throw new Error('progress-check response exceeded maxResponseBytes')
            }
            chunks.push(structuredClone(chunk))
            if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call') || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')) throw new Error('progress-check model attempted a tool call')
            assembler.push(chunk)
            if (chunk.type === 'finish') finished = true
          }
          controller.signal.throwIfAborted()
          if (!eligible(entry, reason)) throw new Error('agent stopped working')
          if (!finished || assembler.finish.kind !== 'stop') throw new Error(`progress-check did not finish normally (${assembler.finish.kind})`)
          stage = 'persist'
          recordResponse()
          await flush(entry)
          controller.signal.throwIfAborted()
          const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
          stage = 'parse'
          const report = modelReportSchema.parse(JSON.parse(text.replace(/^\s*```(?:json)?\s*\n/u, '').replace(/\n```\s*$/u, '')))
          stage = 'persist'
          const seq = appendPluginRecord(session, 'plugin:progress-check/result', {
            version: 1, id, attempt, sessionId: session.id, coveredToolCount: snapshot.toolCount, coveredStepCount: snapshot.stepCount, contextSeq: snapshot.seq,
            report, blocks: assembler.blocks(), ...assembler.usage === undefined ? {} : { usage: assembler.usage },
          })
          await flush(entry)
          entry.covered = snapshot.stepCount
          entry.coveredTools = snapshot.actionToolCount
          return { ok: true, seq }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          const retryable = stage === 'parse' && reason === 'turn-end'
          if (ctx.sessions.get(session.id) !== session) return { ok: false, message }
          try {
            if (!requestRecorded) recordRequest()
            if (!responseRecorded) recordResponse()
            appendPluginRecord(session, 'plugin:progress-check/failure', {
              version: 1, id, attempt, sessionId: session.id, stage, retryable,
              message, canceled: controller.signal.aborted,
              ...error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {},
            })
            await flush(entry)
          } catch (persistError: unknown) {
            ctx.logger.warn(`progress-check ${id}: could not persist attempt ${attempt}: ${String(persistError)}`)
            return { ok: false, message }
          }
          if (!controller.signal.aborted) ctx.logger.warn(`progress-check ${id}, attempt ${attempt}, ${stage}: ${message}`)
          if (!retryable || attempt > config.maxParseRetries.get() || controller.signal.aborted || !eligible(entry, reason)) return { ok: false, message }
        }
      }
    } finally {
      snapshot.signal?.removeEventListener('abort', abort)
    }
  }
  const settle = (entry: Work, operation: Operation, outcome: ProgressOutcome) => {
    if (entry.operation !== operation) return
    if (operation.phase === 'running') active--
    operation.cleanup()
    pending.delete(operation.promise)
    entry.operation = undefined
    operation.resolve(outcome)
    reset(entry)
    pump()
  }
  const queue = (entry: Work, reason: Operation['reason'], stepCount: number, signal?: AbortSignal): Operation => {
    stopTimer(entry)
    entry.due = false
    entry.turnEndDue = false
    const controller = new AbortController()
    const completion = Promise.withResolvers<ProgressOutcome>()
    const timeout = setTimeout(() => controller.abort(new Error('progress-check timed out')), config.timeoutMs.get())
    timeout.unref?.()
    const abortCaller = () => controller.abort(signal?.reason)
    const abortQueued = () => {
      if (operation.phase === 'queued') settle(entry, operation, {
        ok: false, message: controller.signal.reason instanceof Error ? controller.signal.reason.message : 'progress-check canceled',
      })
    }
    const operation: Operation = {
      controller, phase: 'queued', reason, stepCount, promise: completion.promise, resolve: completion.resolve,
      cleanup: () => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', abortCaller)
        controller.signal.removeEventListener('abort', abortQueued)
      },
    }
    entry.operation = operation
    pending.add(operation.promise)
    controller.signal.addEventListener('abort', abortQueued, { once: true })
    signal?.addEventListener('abort', abortCaller, { once: true })
    if (signal?.aborted) abortCaller()
    return operation
  }
  function pump(): void {
    if (stopped) return
    for (const entry of work.values()) {
      if (!alive(entry) || entry.operation?.phase === 'running') continue
      const snapshot = entry.snapshot
      if (snapshot === undefined) continue
      let reason: Operation['reason'] | undefined = entry.operation?.reason
      if (entry.operation === undefined) {
        if (entry.turnEndDue) {
          const state = stateOf(entry.agent)
          if (!config.refreshOnTurnEnd.get() || state.stepCount <= entry.covered || state.actionToolCount <= entry.coveredTools) {
            entry.turnEndDue = false
            continue
          }
          // Nobody is looking: hold the due report until a page shows the Session.
          if (!watched(entry)) continue
          reason = 'turn-end'
        } else {
          if (!running(entry) || !entry.due) continue
          if (snapshot.stepCount - entry.covered < config.intervalSteps.get()) continue
          // Nobody is looking: hold the due report instead of spending a model call
          // on a card no page shows, and let a later presence report resume it.
          if (!watched(entry)) continue
          reason = 'periodic'
        }
      }
      if (active >= config.maxConcurrent.get()) break
      const operation = entry.operation ?? queue(entry, reason!, snapshot.stepCount)
      operation.phase = 'running'
      active++
      // Defer record writes beyond the Session's synchronous event publication.
      void Promise.resolve().then(() => check(entry, snapshot, operation.controller, operation.reason)).then(
        outcome => settle(entry, operation, outcome),
        (error: unknown) => settle(entry, operation, { ok: false, message: String(error) }),
      )
    }
  }

  // Volatile fields commit into the running references without remounting.
  // Re-apply the two values captured by attach() and let the rest be read live.
  let intervalMs = config.intervalMs.get()
  let includeSubagents = config.includeSubagents.get()
  ctx.on('loader/volatile-update', () => {
    const nextInterval = config.intervalMs.get()
    if (nextInterval !== intervalMs) {
      intervalMs = nextInterval
      for (const entry of work.values()) {
        if (entry.operation !== undefined || entry.due || entry.turnEndDue) continue
        stopTimer(entry)
        entry.remaining = nextInterval
        arm(entry)
      }
    }
    const nextInclude = config.includeSubagents.get()
    if (nextInclude !== includeSubagents) {
      includeSubagents = nextInclude
      if (nextInclude) for (const agent of ctx.agents.list()) attach(agent)
      else {
        for (const [id, entry] of work) {
          if (entry.agent.session.header.origin !== 'subagent') continue
          terminate(entry)
          work.delete(id)
        }
      }
    }
    pump()
  })
  // This plugin renders its configuration itself on the Plugins page, so no
  // client should build an automatic page from the schema.
  ctx.inject(['settings'], (scope) => {
    scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber), 'progress-check: configuration page policy')
  })

  ctx.provide('progressCheck', {
    generate: (sessionId, signal) => {
      const entry = work.get(sessionId)
      if (entry === undefined || (!running(entry) && entry.operation === undefined)) {
        return Promise.resolve({ ok: false, message: 'progress-check requires a running session' })
      }
      if (signal.aborted) return Promise.resolve({ ok: false, message: 'progress-check canceled' })
      const operation = entry.operation ?? queue(entry, 'manual', entry.snapshot?.stepCount ?? stateOf(entry.agent).stepCount, signal)
      pump()
      return operation.promise
    },
    reportPresence: (report) => {
      presence.report(report)
      // A page that just came back may have a due report waiting for it.
      pump()
    },
  })
  ctx.inject(['connection'], (scope) => {
    const invalid = () => ({
      ok: false as const,
      error: { code: 'progress-check/invalid-request', message: 'invalid progress-check request', details: {} },
    })
    registerProgressRpc(scope, async (endpoint, payload, signal) => {
      if (endpoint === PRESENCE_METHOD) {
        const report = presenceReportSchema.safeParse(payload)
        if (!report.success) return invalid()
        ctx.progressCheck.reportPresence(report.data)
        return { ok: true, value: {} }
      }
      const request = generateRequestSchema.safeParse(payload)
      if (endpoint !== GENERATE_METHOD || !request.success) return invalid()
      const outcome = await ctx.progressCheck.generate(SessionId(request.data.sessionId), signal)
      return outcome.ok
        ? { ok: true, value: { seq: outcome.seq } }
        : { ok: false, error: { code: 'progress-check/failed', message: outcome.message, details: {} } }
    })
  })

  ctx.on('agent/created', ({ agent }) => { attach(agent); return undefined }, { global: true })
  ctx.on('agent/status', ({ agent, status }) => {
    attach(agent)
    const entry = work.get(agent.session.id)
    if (entry === undefined) return
    if (status === 'idle') pause(entry)
    else arm(entry)
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    const entry = work.get(agent.session.id)
    if (entry === undefined) return
    terminate(entry)
    work.delete(agent.session.id)
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const entry = work.get(session.id)
    if (entry === undefined || !alive(entry)) return
    if ('surfaceOp' in event && event.surfaceOp !== undefined) {
      entry.turnEndDue = false
      entry.snapshot = undefined
    }
    if (event.type === 'turn/end') {
      if (!config.refreshOnTurnEnd.get()) return
      const state = stateOf(entry.agent)
      if (state.actionToolCount <= entry.coveredTools || state.stepCount <= entry.covered) return
      if (entry.operation !== undefined && entry.operation.stepCount >= state.stepCount) return
      const request = buildPostTurnRequest(entry)
      if (request === undefined) return
      entry.snapshot = { request, signal: undefined, toolCount: state.toolCount, actionToolCount: state.actionToolCount, stepCount: state.stepCount, seq: state.seq }
      entry.turnEndDue = true
      if (entry.operation !== undefined && entry.operation.stepCount < state.stepCount) {
        entry.operation.controller.abort(new Error('superseded by turn end'))
      }
      pump()
    }
  }, { global: true })
  ctx.on('llm/stream', (options: GenerateOptions, next) => {
    if (isAgentLoopRequest(options) && options.sessionId !== undefined) {
      const entry = work.get(options.sessionId)
      if (entry !== undefined && running(entry)) {
        const { signal, messages: _messages, toolHistory: _toolHistory, ...template } = options
        const state = stateOf(entry.agent)
        entry.template = structuredClone(template)
        entry.snapshot = { request: structuredClone({ ...template, messages: options.messages, ...options.toolHistory === undefined ? {} : { toolHistory: options.toolHistory } }), signal, toolCount: state.toolCount, actionToolCount: state.actionToolCount, stepCount: state.stepCount, seq: state.seq }
        pump()
      }
    }
    return next()
  }, { global: true, prepend: true })
  ctx.effect(() => () => {
    stopped = true
    for (const entry of work.values()) terminate(entry)
    work.clear()
    presence.clear()
    return Promise.allSettled([...pending]).then(() => {})
  })
  for (const agent of ctx.agents.list()) attach(agent)
}
