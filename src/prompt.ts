/** English progress instructions with the current DSH language preference. */
const QUESTION = `Independently report progress from the full conversation while the main task continues. Do not execute the task, call tools, ask questions outside the report, or devise new plans; report only plans already decided and being carried out.

Return only valid JSON with these exact keys and string-array values, without extra text or code fences:
{"progress":["Working on {specific current subtask}.","Currently {current operation within it}.","Next, {previously decided immediate next action}."],"uncertainties":[],"userActions":[]}

"progress": For large tasks, use exactly these three sentences in order; for small tasks, merge the first two into one current-progress sentence, leaving exactly two items. Fill the placeholders, remove their braces, and translate into the output language. Each item is one non-empty sentence/line about only its assigned action. Omit repetition, added background, the overall task, user request, reviewed material, and earlier stages. Stop the next step at the immediate action.

"uncertainties": only existing unresolved questions you are deeply confused about or technical decisions you are very unsure of. Exclude facts you can verify yourself (even if unchecked), settled plans reframed as needing confirmation, invented concerns, ordinary pending work, routine verification, general risks, and out-of-scope matters.

"userActions": only actions the user can take in parallel now with very high return on effort toward completing the task. Do your own work; put required user answers or operations in your formal reply instead.

For either of the last two fields, use [] if nothing qualifies; empty arrays are normal.

Form complete sentences, then shorten without losing meaning or readability. Report actions, not reading; omit mechanical, generic operations and unnecessary repetition of known information. State final designs, architectural changes, and the overall approach without rationale or implementation details. Use filenames or identifiers only for necessary orientation; do not list paths, identifiers, or code. Distinguish verified results from plans; invent no percentages or problems.

Before output, use non-empty reasoning in the thinking phase to verify facts and validate the final JSON against every requirement. Keep reasoning out of the JSON.`

const RETRY_INSTRUCTION = 'The previous response could not be parsed. Regenerate it following all requirements above.'

/**
 * Build the logged query using the preference at the start of this attempt.
 * @param locale - explicit DSH locale selection; absence preserves conversation-based language selection.
 * @param retry - whether a prior response failed format validation.
 * @returns the complete auxiliary user message, including its output-language instruction.
 */
export function createQuestion(locale: string | undefined, retry: boolean): string {
  const language = locale === undefined
    ? "Use the user's language from the conversation for JSON text."
    : `DSH output language is ${JSON.stringify(locale)} (BCP 47). Use it for JSON text, overriding the conversation and examples.`
  return `<system>\n${QUESTION}${retry ? `\n\n${RETRY_INSTRUCTION}` : ''}\n\n${language}\n</system>`
}
