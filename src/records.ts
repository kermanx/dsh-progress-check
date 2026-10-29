/** Versioned, ignorable progress records; none are part of the model conversation. */
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, FinishReason, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

/** Identity of one auxiliary request and its settlement. */
export type CheckId = Branded<'ProgressCheckId'>
/** Detached provider request; cancellation is process-local. */
export type StoredRequest = Omit<GenerateOptions, 'signal'>

/** Persisted report text and lists consumed by existing cards. */
export const reportSchema = z.object({
  progress: z.string().trim().min(1),
  uncertainties: z.array(z.string().trim().min(1)),
  userActions: z.array(z.string().trim().min(1)),
}).strict()
/** Validate model progress lines and join them for the existing durable report format. */
export const modelReportSchema = reportSchema.extend({
  progress: z.array(z.string().trim().min(1)).min(2).max(3).transform(lines => lines.join('\n')),
})
/** Three answers from the auxiliary model call. */
export type Report = z.infer<typeof reportSchema>
/** Validated persisted result fields consumed by the client and cadence projection. */
export const resultSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  coveredToolCount: z.number().int().nonnegative(),
  coveredStepCount: z.number().int().nonnegative().optional(),
  contextSeq: z.number().int().nonnegative(),
  report: reportSchema,
})
/** Durable successful report and model accounting. */
export interface ResultRecord {
  version: 1
  id: CheckId
  /** One-based attempt; absent on records written before retry support. */
  attempt?: number
  sessionId: SessionId
  coveredToolCount: number
  /** Completed steps in the captured context; absent on older records. */
  coveredStepCount?: number
  contextSeq: number
  report: Report
  blocks: ContentBlock[]
  usage?: TokenUsage
}
/** Durable exact input for reproducing an auxiliary query. */
export interface RequestRecord {
  version: 1
  id: CheckId
  /** One-based attempt; absent on records written before retry support. */
  attempt?: number
  /** False when preparation failed before the provider configuration could be resolved. */
  prepared?: boolean
  sessionId: SessionId
  coveredToolCount: number
  /** Completed steps in the captured context; absent on older records. */
  coveredStepCount?: number
  contextSeq: number
  request: StoredRequest
}
/** Received model output before parsing, including partial responses from failed calls. */
export interface ResponseRecord {
  version: 1
  id: CheckId
  attempt: number
  sessionId: SessionId
  text: string
  chunks: StreamChunk[]
  assemblyError?: string
  blocks: ContentBlock[]
  usage?: TokenUsage
  finish?: FinishReason
  receivedBytes: number
  /** An over-limit chunk is omitted rather than retaining an unbounded response. */
  truncated: boolean
}
/** Operation that failed, distinct from provider terminal reasons in the response record. */
export type FailureStage = 'prepare' | 'request' | 'response' | 'parse' | 'persist'
/** Failed or canceled query; it does not consume the completed-step watermark. */
export interface FailureRecord {
  version: 1
  id: CheckId
  /** One-based attempt; absent on records written before retry support. */
  attempt?: number
  stage?: FailureStage
  /** A format error eligible for retry, subject to the attempt limit and cancellation. */
  retryable?: boolean
  stack?: string
  sessionId: SessionId
  message: string
  canceled: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:progress-check/request': RequestRecord
    'plugin:progress-check/response': ResponseRecord
    'plugin:progress-check/result': ResultRecord
    'plugin:progress-check/failure': FailureRecord
  }
}

/**
 * Read an untrusted durable or wire record without importing the Host Session runtime.
 * @param event - event envelope received from storage or history.
 * @returns validated display data only for this plugin's successful records.
 */
export function readResult(event: { type: string; data: unknown; ignorable?: boolean }): z.infer<typeof resultSchema> | undefined {
  if (event.type !== 'plugin:progress-check/result' || event.ignorable !== true) return undefined
  const parsed = resultSchema.safeParse(event.data)
  return parsed.success ? parsed.data : undefined
}
