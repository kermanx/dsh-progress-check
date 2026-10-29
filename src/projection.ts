/** Host-only fold for completed steps and successful report watermarks. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { readResult } from './records.ts'

const stateSchema = z.object({
  sessionId: z.string(),
  inherited: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  stepCount: z.number().int().nonnegative(),
  covered: z.number().int().nonnegative(),
})
type State = z.infer<typeof stateSchema>
/** Counts child-owned completed steps, without counting request retries or inherited steps. */
export const progressProjection: ProjectionDefinition<'progress-check', State> = {
  key: 'progress-check', stateVersion: 2, stateSchema,
  init: (header, inherited) => ({ sessionId: header.id, inherited, seq: 0, toolCount: 0, stepCount: 0, covered: 0 }),
  apply: (state, event) => {
    if (event.seq < state.inherited) return state
    const result = readResult(event)
    return {
      ...state,
      seq: event.seq,
      toolCount: state.toolCount + (event.type === 'tool/call' ? 1 : 0),
      stepCount: state.stepCount + (event.type === 'step/end' ? 1 : 0),
      covered: result?.sessionId === state.sessionId
        // Old reports establish a step baseline at their completion; their tool
        // count cannot be interpreted as a step count.
        ? Math.max(state.covered, Math.min(state.stepCount, result.coveredStepCount ?? state.stepCount))
        : state.covered,
    }
  },
}
