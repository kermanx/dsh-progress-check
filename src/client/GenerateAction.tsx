/** One immediate progress action beside the running clock. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** Session-bound generation and shell-owned failure reporting. */
export interface GenerateActionProps extends PropsLocale<'progressCheck'> {
  generate(signal: AbortSignal): Promise<boolean>
  onFailure(): void
}

/**
 * Keep one pending click and cancel its request when this Session's action unmounts.
 * @param props - locale, authenticated generator, and persistent failure reporter.
 * @returns a plain text button with an in-place pending label.
 */
export function GenerateAction({ t, generate, onFailure }: GenerateActionProps) {
  const [busy, setBusy] = useState(false)
  const current = useRef<AbortController>()
  useEffect(() => () => { current.current?.abort() }, [])
  const run = async () => {
    if (current.current !== undefined) return
    const controller = new AbortController()
    current.current = controller
    setBusy(true)
    try {
      const succeeded = await generate(controller.signal)
      if (!succeeded && !controller.signal.aborted) onFailure()
    } catch (_error: unknown) {
      // Transport failures use the same localized notice as rejected generation.
      if (!controller.signal.aborted) onFailure()
    } finally {
      if (current.current === controller) {
        current.current = undefined
        if (!controller.signal.aborted) setBusy(false)
      }
    }
  }
  return <button type="button" className="dsh-progress-check-generate" disabled={busy}
    aria-busy={busy} onClick={() => { void run() }}>{t(busy ? 'generating' : 'generate')}</button>
}
