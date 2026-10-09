/** Validated messages on the plugin's authenticated Connection RPC channel. */
import { z } from 'zod'

/** Connection owns authentication, correlation, transport, and cancellation. */
export const PROGRESS_CHANNEL = '/progress-check'
/** The sole operation on this channel. */
export const GENERATE_METHOD = 'generate'
/** Untrusted browser input; only the target Session may be chosen. */
export const generateRequestSchema = z.object({ sessionId: z.string().min(1) }).strict()
/** Successful response identifies the durable report already delivered through Session history. */
export const generateResponseSchema = z.object({ seq: z.number().int().nonnegative() }).strict()
