/** Floating progress card with a persistent time/steps toggle, refresh icon, and reply actions. */
import { useEffect, useState, type ReactNode } from 'react'
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Report } from '../records.ts'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const AGE_MODE_KEY = 'dsh-progress-check:age-mode'

function readShowSteps(): boolean {
  try {
    return globalThis.localStorage?.getItem(AGE_MODE_KEY) === 'steps'
  } catch {
    return false
  }
}

function writeShowSteps(showSteps: boolean): void {
  try {
    globalThis.localStorage?.setItem(AGE_MODE_KEY, showSteps ? 'steps' : 'time')
  } catch {
    // Ignore storage failures in restricted contexts.
  }
}

/** Milliseconds until `relativeTime(updatedAt, now)` crosses into its next display bucket. */
function nextBucketDelay(updatedAt: number, now: number): number {
  const diff = Math.max(0, now - updatedAt)
  if (diff < HOUR_MS) return MINUTE_MS - (diff % MINUTE_MS)
  if (diff < DAY_MS) return HOUR_MS - (diff % HOUR_MS)
  return DAY_MS - (diff % DAY_MS)
}

/** Format one coarse relative-time bucket (`<1min ago`, `2min ago`, `3h ago`, ...). */
function formatAge(updatedAt: number, now: number, t: PropsLocale<'progressCheck'>['t']): string {
  const { unit, n } = relativeTime(updatedAt, now)
  switch (unit) {
    case 'now': return t('timeNow')
    case 'minutes': return t('timeMinutes', { n: String(n) })
    case 'hours': return t('timeHours', { n: String(n) })
    case 'days': return t('timeDays', { n: String(n) })
    case 'months': return t('timeMonths', { n: String(n) })
    case 'years': return t('timeYears', { n: String(n) })
  }
}

/** Data and composer action supplied by the session-bound dock slot. */
export interface CardProps extends PropsLocale<'progressCheck'> {
  report: Report
  updatedAt: number
  stepsAgo: number
  staleUpdating?: boolean
  disabled: boolean
  action?: ReactNode
  onReply(question: string): void
}

/**
 * Render the floating progress card with a remembered time/steps toggle and
 * optional refresh icon action on the right.
 * @param props - report, creation timestamp, steps ago, stale-updating state, locale, optional action, and reply handler.
 * @returns the floating progress card.
 */
export function Card({ report, updatedAt, stepsAgo, staleUpdating = false, t, disabled, action, onReply }: CardProps) {
  const [now, setNow] = useState(() => Date.now())
  const [showSteps, setShowSteps] = useState(readShowSteps)
  useEffect(() => {
    setNow(Date.now())
  }, [updatedAt])
  useEffect(() => {
    if (showSteps) return
    const delay = nextBucketDelay(updatedAt, now)
    const timer = setTimeout(() => { setNow(Date.now()) }, delay)
    return () => { clearTimeout(timer) }
  }, [updatedAt, now, showSteps])
  const toggleAgeMode = () => {
    setShowSteps((prev) => {
      const next = !prev
      writeShowSteps(next)
      return next
    })
  }
  const ageText = showSteps
    ? t(stepsAgo === 1 ? 'stepAgoOne' : 'stepsAgo', { n: String(stepsAgo) })
    : formatAge(updatedAt, now, t)
  const linkEntries = Object.entries(report.links ?? {})
  return <section className="dsh-progress-check" aria-label={t('aria')} data-stale-updating={staleUpdating ? 'true' : undefined}>
    {staleUpdating && <div className="dsh-progress-check-bar" aria-hidden="true" />}
    <dl>
      <dt>{t('progress')}</dt>
      <dd className="dsh-progress-check-progress">{report.progress}</dd>
      {report.uncertainties.length > 0 && <>
        <dt>{t('uncertainties')}</dt>
        <dd>{report.uncertainties.join(t('separator'))}</dd>
      </>}
      {report.userActions.length > 0 && <>
        <dt>{t('userActions')}</dt>
        <dd>{report.userActions.map((question, index) => <div key={index}>
          {question}{' '}
          <button className="dsh-progress-check-reply" type="button" disabled={disabled} onClick={() => onReply(question)}>{t('reply')}</button>
        </div>)}</dd>
      </>}
      {linkEntries.length > 0 && <>
        <dt>{t('links')}</dt>
        <dd className="dsh-progress-check-links">{linkEntries.map(([desc, url]) => (
          /^https?:\/\//i.test(url)
            ? <a key={url} className="dsh-progress-check-link" href={url} target="_blank" rel="noopener noreferrer">{desc}</a>
            : <span key={url}>{desc}: {url}</span>
        ))}</dd>
      </>}
    </dl>
    <div className="dsh-progress-check-actions">
      <button
        type="button"
        className="dsh-progress-check-time"
        aria-pressed={showSteps}
        title={new Date(updatedAt).toLocaleString()}
        onClick={toggleAgeMode}
      >
        {ageText}
      </button>
      {action}
    </div>
  </section>
}
