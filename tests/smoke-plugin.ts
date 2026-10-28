/** Keyless Web smoke fixture. Loaded only by an isolated DSH test profile. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-title'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'

class FixtureAdapter extends LlmAdapter {
  private calls = new Map<string, number>()
  private checked = new Set<string>()
  constructor(private readonly fixtureContext: Context) { super() }
  override async listModels() { return [{ id: 'progress-fixture', name: 'Progress fixture' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== undefined) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '进展卡片验证' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (!isAgentLoopRequest(options)) {
      const sessionId = options.sessionId ?? ''
      if (!this.checked.has(sessionId)) {
        this.checked.add(sessionId)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"progress":' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if ((this.calls.get(sessionId) ?? 0) < 3) await new Promise<void>(resolve => {
        const finish = () => { dispose(); options.signal?.removeEventListener('abort', finish); resolve() }
        const dispose = this.fixtureContext.on('llm/stream', (request, next) => {
          if (request.sessionId === sessionId && isAgentLoopRequest(request)) finish()
          return next()
        }, { global: true })
        if (options.signal?.aborted) finish()
        else options.signal?.addEventListener('abort', finish, { once: true })
      })
      if (options.signal?.aborted) return
      const second = (this.calls.get(options.sessionId ?? '') ?? 0) > 2
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ progress: second ? ['正在完成会话保存修复。', '正在验证旧格式读取和恢复。', '下一步检查恢复后的会话内容。'] : ['正在修复会话保存问题。', '正在验证保存失败的修复。', '下一步验证旧格式读取和恢复。'], uncertainties: ['旧格式应统一迁移还是保留独立兼容层，目前无法确定。'], userActions: ['请并行确认仍在使用的旧格式版本范围，帮助缩小兼容验证范围。'] }) } }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 90 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const id = options.sessionId ?? ''
    const count = this.calls.get(id) ?? 0
    this.calls.set(id, count + 1)
    if (count > 0) await new Promise<void>(resolve => {
      const finish = () => { dispose(); options.signal?.removeEventListener('abort', finish); resolve() }
      const dispose = this.fixtureContext.on('session/event', (session, event) => {
        if (session.id === id && event.type === 'plugin:progress-check/request') finish()
      }, { global: true })
      if (options.signal?.aborted) finish()
      else options.signal?.addEventListener('abort', finish, { once: true })
    })
    if (options.signal?.aborted) return
    const text = Array.from({ length: 16 }, (_, index) => `验证记录 ${count + 1}.${index + 1}：逐项检查会话保存、旧格式读取和恢复后的内容，保持检查结果可追踪。`).join('\n\n')
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (count < 2) {
      for (let index = 0; index < 6; index++) yield { type: 'block-end', index: index + 1, block: { type: 'tool-call', id: ToolCallId(`smoke-${count}-${index}`), name: 'progress_fixture_read', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    await new Promise<void>(resolve => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    yield { type: 'finish', reason: { kind: 'aborted' } }
  }
}
export const inject = ['agents', 'agentLoop', 'llm', 'tools', 'sessionTitle']
export async function apply(ctx: Context): Promise<void> {
  ctx.llm.registerAdapter(['progress-fixture'], new FixtureAdapter(ctx))
  ctx.tools.register(defineContentToolFixture({ name: 'progress_fixture_read', description: 'Read an in-memory test fixture', parameters: {}, async execute() { return [{ type: 'text', text: 'Fixture read complete' }] } }))
  {
    const handle = await ctx.agents.create({ sessionId: SessionId(`progress-preview-${randomUUID()}`), meta: { cwd: process.cwd() }, agentOptions: { provider: 'progress-fixture', model: 'progress-fixture' } })
    await ctx.sessionTitle.rename(handle.agent.session, '进展卡片验证')
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '演示任务进展卡片。' }], source: { kind: 'user' } }))
  }
}
