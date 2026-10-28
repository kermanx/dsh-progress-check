/** Validated messages on the plugin's authenticated Connection RPC channel. */
import { z } from 'zod'

/** Connection owns authentication, correlation, transport, and cancellation. */
export const PROGRESS_CHANNEL = '/api'
/** The sole generation operation on this channel. */
export const GENERATE_METHOD = 'progress-check/generate'
/** Untrusted browser input; only the target Session may be chosen. */
export const generateRequestSchema = z.object({ sessionId: z.string().min(1) }).strict()
/** Successful response identifies the durable report already delivered through Session history. */
export const generateResponseSchema = z.object({ seq: z.number().int().nonnegative() }).strict()

/** Visibility operation: which Sessions a browser page is actually showing. */
export const PRESENCE_METHOD = 'progress-check/presence'
/** Refresh cadence of a foreground page; the Host expires a report after {@link PRESENCE_TTL_MS}. */
export const PRESENCE_HEARTBEAT_MS = 5000
/**
 * How long one report keeps counting. Three heartbeats absorb a throttled or
 * delayed tick while a closed tab stops refreshing and expires on its own.
 */
export const PRESENCE_TTL_MS = PRESENCE_HEARTBEAT_MS * 3

/**
 * One browser page's statement about what it is showing. The page owns the
 * identity, so several tabs on different Sessions coexist in Host state.
 */
export const presenceReportSchema = z.object({
  /** Stable for one page load. */
  clientId: z.string().min(1).max(128),
  /** Sessions this page currently shows in its main area. */
  sessionIds: z.array(z.string().min(1).max(256)).max(32),
  /** Whether the page is on screen: its tab is visible and its window focused. */
  visible: z.boolean(),
}).strict()
/** Validated presence report. */
export type ClientPresence = z.infer<typeof presenceReportSchema>
