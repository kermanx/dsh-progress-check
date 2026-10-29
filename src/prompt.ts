/** English progress instructions with the current DSH language preference. */
const QUESTION = `Independently report progress from the full conversation while the main task continues. Do not execute the task, call tools, ask questions outside the report, or devise new plans; report only plans already decided and being carried out.

First verify facts and requirements in the thinking phase with non-empty reasoning; exclude reasoning from the final JSON.

Return only a valid JSON object with exactly "progress", "uncertainties", and "userActions", all arrays of strings. No extra text or code fences.

"progress" must follow this order:
- Large tasks: exactly three items: current subtask, current operation within it, previously decided next step.
- Small tasks: exactly two items: current progress, previously decided next step.

Fill and translate this template into the output language, replacing placeholders and removing braces. For small tasks, combine the first two sentences; fill the other arrays only as specified below:
{"progress":["Working on {subtask}.","Currently {operation}.","Next, {previously decided immediate next step}."],"uncertainties":[],"userActions":[]}

Each item contains one action in its assigned position, without repetition or added background. Directly name the current stage and operation; do not restate the task, user request, reviewed material, or earlier stages. Give only the previously decided immediate next action, without later steps.

Write one sentence per item/line: form a complete sentence, then shorten without losing meaning or readability. Report actions, not reading; omit mechanical, generic operations and unnecessary repetition of known information. State final designs, architectural changes, and the overall approach without rationale or implementation details. Use filenames or identifiers only for necessary orientation; do not list paths, identifiers, or code.

"uncertainties": only existing unresolved questions you are deeply confused about or technical decisions you are very unsure of. Exclude facts you can verify yourself, settled plans reframed as needing confirmation, invented concerns, ordinary pending work, routine verification, general risks, and out-of-scope matters. Use [] if none qualify.

"userActions": only actions the user can take in parallel now with very high return on effort toward completing the task. Do not delegate your own work. Put required user answers or operations in your formal reply instead. Use [] if none qualify.

Use the specified output language. Distinguish verified results from plans; invent no percentages or problems. Before output, check JSON syntax, item counts, one sentence per item, next step last, and eligibility of the other two arrays' contents. Empty arrays are normal.`

const RETRY_INSTRUCTION = 'The previous response could not be parsed. Rewrite strictly under the JSON requirements above: progress has two or three non-empty, single-sentence items, with the next step last; the other arrays are empty unless content qualifies. No extra fields, explanations, or code fences.'

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
  return `<system>\n${QUESTION}${retry ? `\n\n${RETRY_INSTRUCTION}` : ''}\n\n${language} Keep field names unchanged.\n</system>`
}
