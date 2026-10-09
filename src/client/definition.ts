/** Each successful durable report produces an always-visible session-level card. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { readResult } from '../records.ts'
import type { Report } from '../records.ts'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'progress-check': Report
  }
}
interface State { contextSeq: number; report: Report }
/** Reports follow their captured context, outside the Turn's work-details disclosure. */
export const progressDefinition: ConversationNodeDefinition<State> = {
  kind: 'progress-check', target: 'chat',
  match: event => {
    const result = readResult(event)
    // Sequence ordering keeps repeated reports for the same context chronological.
    return result === undefined ? null : { id: `${String(event.seq).padStart(16, '0')}:${result.id}`, role: 'start' }
  },
  start: (_context, match) => {
    const result = readResult(match.event)
    if (result === undefined) throw new Error('invalid progress-check record')
    return { contextSeq: result.contextSeq, report: result.report }
  },
  update: context => context.state,
  buildViewNode: (context): ChatConversationViewNode | null => context.state === undefined ? null : {
    key: context.key, kind: 'progress-check', id: context.id, target: 'chat',
    anchorSeq: context.state.contextSeq + 0.5, location: { kind: 'session' }, visibility: 'visible', data: context.state.report,
  },
}
