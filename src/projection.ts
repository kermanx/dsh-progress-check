/** Host-only fold for actual tool calls and successful report watermarks. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { readResult } from './records.ts'

const stateSchema = z.object({
  sessionId: z.string(),
  inherited: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  covered: z.number().int().nonnegative(),
})
type State = z.infer<typeof stateSchema>
declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    'progress-check': State
  }
}
/** Counts child-owned tool/call events, without counting retries or inherited calls. */
export const progressProjection: ProjectionDefinition<'progress-check'> = {
  key: 'progress-check', stateVersion: 1, stateSchema,
  init: (header, inherited) => ({ sessionId: header.id, inherited, seq: 0, toolCount: 0, covered: 0 }),
  apply: (state, event) => {
    if (event.seq < state.inherited) return state
    const result = readResult(event)
    return {
      ...state,
      seq: event.seq,
      toolCount: state.toolCount + (event.type === 'tool/call' ? 1 : 0),
      covered: result?.sessionId === state.sessionId
        ? Math.max(state.covered, Math.min(state.toolCount, result.coveredToolCount))
        : state.covered,
    }
  },
}
