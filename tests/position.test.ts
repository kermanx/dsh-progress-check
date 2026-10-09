import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembler.ts'
import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { messageDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/message.ts'
import { progressDefinition } from '../src/client/definition.ts'
import type { CheckId, Report } from '../src/records.ts'

function message(seq: number, text: string): SessionLiveEventEntry {
  return { type: 'event', event: {
    type: 'user/message', seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
    data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
  } }
}

function result(seq: number, id: string, progress: string): SessionLiveEventEntry {
  return { type: 'event', event: {
    type: 'plugin:progress-check/result', seq: SessionSeq(seq), time: seq, ignorable: true,
    data: {
      version: 1, id: id as CheckId, sessionId: SessionId('position-test'),
      contextSeq: 11, coveredToolCount: 6, blocks: [],
      report: { progress, uncertainties: [], userActions: [] },
    },
  } }
}

function assemble(events: SessionLiveEventEntry[]) {
  const assembler = new ConversationNodeAssembler({
    entries: () => [messageDefinition, progressDefinition], fallbackEntry: () => undefined,
  }, { entries: () => [chatViewDefinition] })
  assembler.replaceWindow(events, false)
  assembler.activateTarget('chat')
  return assembler
}

function order(assembler: ConversationNodeAssembler) {
  assembler.flush()
  const snapshot = assembler.get('chat')!
  return snapshot.order.map(key => {
    const node = snapshot.nodes.get(key)!
    return node.kind === 'progress-check' ? (node.data as Report).progress : node.kind
  })
}

it('inserts a completed report at its request context, before messages received while generating', () => {
  const before = [message(10, '生成前的上下文'), message(20, '生成期间新增的消息')]
  const completed = result(30, 'report-one', '第一张进展')
  const live = assemble(before)
  expect(order(live)).toEqual(['user', 'user'])
  live.append(completed)
  expect(order(live)).toEqual(['user', '第一张进展', 'user'])
  expect(order(assemble([...before, completed]))).toEqual(order(live))
})

it('keeps reports about the same context in generation order after reload', () => {
  const events = [message(10, '生成前的上下文'), message(20, '之后的新消息'),
    result(30, 'z-first', '第一张进展'), result(40, 'a-second', '第二张进展')]
  const live = assemble(events.slice(0, 2))
  live.append(events[2]!)
  live.append(events[3]!)
  expect(order(live)).toEqual(['user', '第一张进展', '第二张进展', 'user'])
  expect(order(assemble(events))).toEqual(order(live))
})
