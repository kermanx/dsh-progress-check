/** Progress answers with Session-wide disclosure and adjacent reply actions; answers without content are omitted. */
import { useId } from 'react'
import { Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Report } from '../records.ts'

/** Data and composer action supplied by the session-bound slot. */
export interface CardProps extends PropsLocale<'progressCheck'> {
  report: Report
  disabled: boolean
  expanded: boolean
  onToggle(): void
  onReply(question: string): void
}
/**
 * Keep a one-line progress summary when collapsed; expansion shows every non-empty answer.
 * @param props - report, shared disclosure, locale, and draft-only reply action.
 * @returns the progress card.
 */
export function Card({ report, t, disabled, expanded, onToggle, onReply }: CardProps) {
  const contentId = useId()
  const toggleLabel = t(expanded ? 'collapseAll' : 'expandAll')
  return <section className="dsh-progress-check" aria-label={t('aria')} data-expanded={expanded}>
    <dl id={contentId}>
      <dt>{t('progress')}</dt>
      <dd className="dsh-progress-check-progress">{report.progress}</dd>
      {expanded && <>
        {report.uncertainties.length > 0 && <>
          <dt>{t('uncertainties')}</dt>
          <dd>{report.uncertainties.join('；')}</dd>
        </>}
        {report.userActions.length > 0 && <>
          <dt>{t('userActions')}</dt>
          <dd>{report.userActions.map((question, index) => <div key={index}>
            {question}{' '}
            <button className="dsh-progress-check-reply" type="button" disabled={disabled} onClick={() => onReply(question)}>{t('reply')}</button>
          </div>)}</dd>
        </>}
      </>}
    </dl>
    <Tooltip label={toggleLabel} side="bottom" align="end" portal>
      <Button size="sm" className="dsh-progress-check-toggle" aria-label={toggleLabel}
        aria-expanded={expanded} aria-controls={contentId} onClick={onToggle}
        icon={expanded ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />} />
    </Tooltip>
  </section>
}
