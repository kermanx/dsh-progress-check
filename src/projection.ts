/** Host projection for completed steps, report watermarks, and the latest client card. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { progressViewSchema, readResult, reportSchema } from './records.ts'

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'glob', 'read_image'])
const READ_ONLY_BASH_CMDS = new Set(['cat', 'ls', 'head', 'tail', 'pwd', 'which', 'echo', 'stat', 'wc', 'file', 'tree'])

/** Whether a tool call performs work beyond obvious read-only inspection. */
export function isActionToolCall(name: string, argsJson?: string): boolean {
  if (READ_ONLY_TOOLS.has(name)) return false
  if (name === 'bash' && typeof argsJson === 'string') {
    try {
      const parsed = JSON.parse(argsJson) as { command?: unknown }
      if (typeof parsed.command === 'string' && !/[><`$()]/.test(parsed.command)) {
        const segments = parsed.command.split(/&&|\|\||[;|]/).map(s => s.trim()).filter(Boolean)
        if (segments.length > 0 && segments.every((seg) => {
          const tokens = seg.split(/\s+/).filter(token => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
          return tokens.length > 0 && READ_ONLY_BASH_CMDS.has(tokens[0]!)
        })) return false
      }
    } catch {
      // Malformed arguments are treated as non-read-only.
    }
  }
  return true
}

const latestSchema = z.object({
  id: z.string().min(1),
  updatedAt: z.number().nonnegative(),
  stepsAgo: z.number().int().nonnegative(),
  needsRefresh: z.boolean(),
  report: reportSchema,
})
const stateSchema = z.object({
  sessionId: z.string(),
  inherited: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  actionToolCount: z.number().int().nonnegative().default(0),
  stepCount: z.number().int().nonnegative(),
  covered: z.number().int().nonnegative(),
  coveredActionTools: z.number().int().nonnegative().default(0),
  latest: latestSchema.nullable().default(null),
})
type State = z.infer<typeof stateSchema>
type ProgressProjection = ProjectionDefinition<'progress-check', State>
/** Counts child-owned completed steps, tracks watermarks, and exposes only the latest report to the client. */
export const progressProjection: ProgressProjection & { wire: NonNullable<ProgressProjection['wire']> } = {
  key: 'progress-check', stateVersion: 7, stateSchema,
  wire: { viewSchema: progressViewSchema, view: state => state.latest, summary: false },
  init: (header, inherited) => ({ sessionId: header.id, inherited, seq: 0, toolCount: 0, actionToolCount: 0, stepCount: 0, covered: 0, coveredActionTools: 0, latest: null }),
  apply: (state, event) => {
    if (event.seq < state.inherited) return state
    const result = readResult(event)
    const mine = result?.sessionId === state.sessionId
    const isTool = event.type === 'tool/call'
    const isActionTool = isTool && isActionToolCall(event.data.name, event.data.arguments)
    const toolCount = state.toolCount + (isTool ? 1 : 0)
    const actionToolCount = state.actionToolCount + (isActionTool ? 1 : 0)
    const stepCount = state.stepCount + (event.type === 'step/end' ? 1 : 0)
    const covered = mine
      // Old reports establish a step baseline at their completion; their tool
      // count cannot be interpreted as a step count.
      ? Math.max(state.covered, Math.min(state.stepCount, result.coveredStepCount ?? state.stepCount))
      : state.covered
    const coveredActionTools = mine ? actionToolCount : state.coveredActionTools
    const stepsAgo = Math.max(0, stepCount - covered)
    const needsRefresh = stepsAgo > 0 && actionToolCount > coveredActionTools
    const latest = mine
      ? { id: result.id, updatedAt: event.time, stepsAgo, needsRefresh, report: result.report }
      : state.latest !== null && (event.type === 'step/end' || isActionTool)
        ? { ...state.latest, stepsAgo, needsRefresh }
        : state.latest
    return {
      ...state,
      seq: event.seq,
      toolCount,
      actionToolCount,
      stepCount,
      covered,
      coveredActionTools,
      latest,
    }
  },
}
