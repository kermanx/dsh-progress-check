/** Manual progress generation shared by the scheduler and its Web adapter. */
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Settlement after the report has been persisted or generation has stopped. */
export type ProgressOutcome =
  | { ok: true; seq: SessionSeq }
  | { ok: false; message: string }

/** Immediate generation for an already-running Session. */
export interface ProgressCheckService {
  /**
   * Bypass cadence and call thresholds, sharing an existing query when present.
   * @param sessionId - live Session to inspect; cold or idle Sessions are refused.
   * @param signal - caller lifetime; cancels a newly created query, but not a query it joined.
   * @returns the persisted report sequence or failure; incomplete tool pairs wait for the next complete request.
   */
  generate(sessionId: SessionId, signal: AbortSignal): Promise<ProgressOutcome>
}

declare module '@deepseek-ai/cordis' {
  interface Context { progressCheck: ProgressCheckService }
}
