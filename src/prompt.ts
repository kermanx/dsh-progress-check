/** Compact English progress instructions with turn-phase context and DSH language preference. */
const QUESTION = `Report progress from the conversation. Do not run tools, continue the task, ask externally, or invent plans; report only decided/active work or completed turn outcomes.

Return ONLY raw JSON (string arrays, no fences/extra text; [] is normal when empty):
{"progress":["{current work or turn outcome}","{optional immediate next step}"],"uncertainties":[],"userActions":[]}

- progress: 1–2 ultra-short telegraphic lines (<=15 words or ~25 CJK chars each; fill placeholders without braces). Line 1: active work or turn outcome. Line 2 (omit if done or small): immediate next step or pending follow-up only. Omit repetition, background, overall goal/request, reviewed material, and prior stages.
- uncertainties: only genuine confusion or very uncertain technical choices. Exclude self-verifiable facts (even unchecked), settled plans, routine work/verification, general risks, and invented or out-of-scope issues.
- userActions: only high-ROI actions the user can take now (in parallel while running, or follow-up decisions/inputs after turn end); do your own work.

Report actions/results, not reading or generic/mechanical steps. State final designs/architecture/approach without rationale or implementation details. Name files/symbols only for essential orientation; never list paths, identifiers, or code. Distinguish verified results from plans; invent no percentages or problems.

Use non-empty thinking to verify facts and every rule before outputting JSON; keep reasoning out of JSON.`

const RETRY_INSTRUCTION = 'The previous response could not be parsed. Follow all rules above.'

export type ProgressPhase = 'running' | 'turn-end'

/**
 * Build the logged query using the preference at the start of this attempt.
 * @param locale - explicit DSH locale selection; absence preserves conversation-based language selection.
 * @param retry - whether a prior response failed format validation.
 * @param phase - whether the turn is still running or just ended.
 * @returns the complete auxiliary user message, including its phase and output-language instruction.
 */
export function createQuestion(locale: string | undefined, retry: boolean, phase: ProgressPhase = 'running'): string {
  const state = phase === 'turn-end'
    ? 'Phase: turn ended — summarize what settled this turn; omit next step if complete.'
    : 'Phase: turn in progress — report current work and decided immediate next step.'
  const language = locale === undefined
    ? "Use the user's language from the conversation."
    : `DSH output language is ${JSON.stringify(locale)} (BCP 47), overriding conversation/examples.`
  return `<system>\n${QUESTION}\n\n${state}${retry ? `\n\n${RETRY_INSTRUCTION}` : ''}\n\n${language}\n</system>`
}
