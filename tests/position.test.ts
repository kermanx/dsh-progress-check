import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { isActionToolCall, progressProjection } from '../src/projection.ts'
import type { CheckId } from '../src/records.ts'

const SESSION = SessionId('position-test')
const HEADER: SessionHeader = { id: SESSION, createdAt: 0 }

function userEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message', seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
    data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
  }
}

function resultEvent(seq: number, id: string, progress: string, sessionId: SessionId = SESSION): SessionEvent {
  return {
    type: 'plugin:progress-check/result', seq: SessionSeq(seq), time: seq, ignorable: true,
    data: {
      version: 1, id: id as CheckId, sessionId,
      contextSeq: 11, coveredToolCount: 6, coveredStepCount: 5, blocks: [],
      report: { progress, uncertainties: [], userActions: [] },
    },
  }
}

it('exposes null until a report arrives and keeps only the latest report in the wire view', () => {
  let state = progressProjection.init(HEADER, SessionLogOffset(0))
  expect(progressProjection.wire!.view(state)).toBeNull()

  state = progressProjection.apply(state, userEvent(10, '生成前的上下文'))
  expect(progressProjection.wire!.view(state)).toBeNull()

  state = progressProjection.apply(state, resultEvent(20, 'report-one', '第一张进展'))
  const firstView = progressProjection.wire!.view(state)
  expect(firstView).toEqual({
    id: 'report-one',
    updatedAt: 20,
    stepsAgo: 0,
    needsRefresh: false,
    report: { progress: '第一张进展', uncertainties: [], userActions: [] },
  })

  // Unrelated events keep the exact same view reference so downstream subscribers do not re-render.
  state = progressProjection.apply(state, userEvent(25, '之后的普通消息'))
  expect(progressProjection.wire!.view(state)).toBe(firstView)

  state = progressProjection.apply(state, resultEvent(30, 'report-two', '第二张进展'))
  expect(progressProjection.wire!.view(state)).toEqual({
    id: 'report-two',
    updatedAt: 30,
    stepsAgo: 0,
    needsRefresh: false,
    report: { progress: '第二张进展', uncertainties: [], userActions: [] },
  })
})

it('ignores inherited pre-fork reports and reports from other sessions', () => {
  let state = progressProjection.init(HEADER, SessionLogOffset(20))
  state = progressProjection.apply(state, resultEvent(10, 'inherited', '父会话旧进展'))
  state = progressProjection.apply(state, resultEvent(30, 'foreign', '其他会话进展', SessionId('other-session')))
  expect(progressProjection.wire!.view(state)).toBeNull()
})

it('excludes read/grep/glob and read-only bash commands from action tool calls', () => {
  expect(isActionToolCall('read', '{}')).toBe(false)
  expect(isActionToolCall('grep', '{}')).toBe(false)
  expect(isActionToolCall('glob', '{}')).toBe(false)
  expect(isActionToolCall('bash', JSON.stringify({ command: 'ls -la && cat package.json' }))).toBe(false)
  expect(isActionToolCall('bash', JSON.stringify({ command: 'cat a.txt | head -n 5' }))).toBe(false)
  expect(isActionToolCall('bash', JSON.stringify({ command: 'echo hi > out.txt' }))).toBe(true)
  expect(isActionToolCall('bash', JSON.stringify({ command: 'pnpm test' }))).toBe(true)
  expect(isActionToolCall('edit', '{}')).toBe(true)
})
