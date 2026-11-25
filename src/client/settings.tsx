/** This plugin's configuration page on the Plugins page. */
import { useId } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsValueField, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { ProgressSettingsFace } from './settings-form.ts'

/** Props the renderer binds for the configuration page. */
export type ProgressSettingsCardProps = PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'progressCheck'>
  & InjectFace<ProgressSettingsFace>

/** One two-state setting that saves with the rest of the form. */
function SettingsSwitch(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly checked: boolean
  readonly overridden: boolean
  readonly disabled: boolean
  readonly overriddenLabel: string
  readonly resetLabel: string
  readonly onChange: (next: boolean) => void
  readonly onReset: () => void
}) {
  const hintId = `${props.id}-hint`
  return (
    <div className="dsh-progress-check-settings-toggle">
      <div className="dsh-progress-check-settings-toggle-copy">
        <span className="dsh-progress-check-settings-toggle-label">{props.label}</span>
        <p className="dsh-progress-check-settings-toggle-hint" id={hintId}>{props.hint}</p>
      </div>
      <div className="dsh-progress-check-settings-toggle-control">
        {props.overridden && (
          <span className="dsh-progress-check-settings-badges">
            <Tag tone="neutral">{props.overriddenLabel}</Tag>
            <button
              type="button"
              className="dsh-progress-check-settings-reset"
              disabled={props.disabled}
              onClick={props.onReset}
            >
              {props.resetLabel}
            </button>
          </span>
        )}
        <Switch
          checked={props.checked}
          label={props.label}
          describedBy={hintId}
          disabled={props.disabled}
          onChange={props.onChange}
        />
      </div>
    </div>
  )
}

/**
 * Render the plugin's configuration: automatic-report cadence, its two
 * switches, and the resource limits one report is bound by.
 * @param props - locale copy, the staged form snapshot, and its save actions.
 * @returns the staged settings form.
 */
export function ProgressSettingsCard(props: ProgressSettingsCardProps) {
  const { t } = props
  const state = props.useProgressSettings(snapshot => snapshot)
  const headingId = useId()
  const disabled = !state.writable || state.saving
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <p className="dsh-progress-check-settings-note">{t('settingsNote')}</p>
      <section className="dsh-progress-check-settings-section" aria-labelledby={`${headingId}-auto`}>
        <h3 className="dsh-progress-check-settings-heading" id={`${headingId}-auto`}>{t('settingsAuto')}</h3>
        <SettingsValueField
          id="progress-check-interval-ms"
          label={t('intervalMs')}
          hint={t('intervalMsHint')}
          numeric
          disabled={disabled}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalidNumber')}
          {...state.intervalMs}
          onEdit={(text) => { props.edit('intervalMs', text) }}
          onReset={() => { props.resetField('intervalMs') }}
        />
        <SettingsValueField
          id="progress-check-interval-steps"
          label={t('intervalSteps')}
          hint={t('intervalStepsHint')}
          numeric
          disabled={disabled}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalidNumber')}
          {...state.intervalSteps}
          onEdit={(text) => { props.edit('intervalSteps', text) }}
          onReset={() => { props.resetField('intervalSteps') }}
        />
        <SettingsSwitch
          id="progress-check-only-when-visible"
          label={t('onlyWhenVisible')}
          hint={t('onlyWhenVisibleHint')}
          checked={state.onlyWhenVisible.text === 'true'}
          overridden={state.onlyWhenVisible.overridden}
          disabled={disabled}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          onChange={(next) => { props.edit('onlyWhenVisible', next ? 'true' : 'false') }}
          onReset={() => { props.resetField('onlyWhenVisible') }}
        />
        <SettingsSwitch
          id="progress-check-include-subagents"
          label={t('includeSubagents')}
          hint={t('includeSubagentsHint')}
          checked={state.includeSubagents.text === 'true'}
          overridden={state.includeSubagents.overridden}
          disabled={disabled}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          onChange={(next) => { props.edit('includeSubagents', next ? 'true' : 'false') }}
          onReset={() => { props.resetField('includeSubagents') }}
        />
        <SettingsSwitch
          id="progress-check-refresh-on-turn-end"
          label={t('refreshOnTurnEnd')}
          hint={t('refreshOnTurnEndHint')}
          checked={state.refreshOnTurnEnd.text === 'true'}
          overridden={state.refreshOnTurnEnd.overridden}
          disabled={disabled}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          onChange={(next) => { props.edit('refreshOnTurnEnd', next ? 'true' : 'false') }}
          onReset={() => { props.resetField('refreshOnTurnEnd') }}
        />
      </section>
      <section className="dsh-progress-check-settings-section" aria-labelledby={`${headingId}-limits`}>
        <h3 className="dsh-progress-check-settings-heading" id={`${headingId}-limits`}>{t('settingsLimits')}</h3>
        <SettingsValueField
          id="progress-check-timeout-ms"
          label={t('timeoutMs')}
          hint={t('timeoutMsHint')}
          numeric
          disabled={disabled}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalidNumber')}
          {...state.timeoutMs}
          onEdit={(text) => { props.edit('timeoutMs', text) }}
          onReset={() => { props.resetField('timeoutMs') }}
        />
        <SettingsValueField
          id="progress-check-response-bytes"
          label={t('maxResponseBytes')}
          hint={t('maxResponseBytesHint')}
          numeric
          disabled={disabled}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalidNumber')}
          {...state.maxResponseBytes}
          onEdit={(text) => { props.edit('maxResponseBytes', text) }}
          onReset={() => { props.resetField('maxResponseBytes') }}
        />
        <SettingsValueField
          id="progress-check-parse-retries"
          label={t('maxParseRetries')}
          hint={t('maxParseRetriesHint')}
          numeric
          disabled={disabled}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalidNumber')}
          {...state.maxParseRetries}
          onEdit={(text) => { props.edit('maxParseRetries', text) }}
          onReset={() => { props.resetField('maxParseRetries') }}
        />
        <SettingsValueField
          id="progress-check-max-concurrent"
          label={t('maxConcurrent')}
          hint={t('maxConcurrentHint')}
          numeric
          disabled={disabled}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalidNumber')}
          {...state.maxConcurrent}
          onEdit={(text) => { props.edit('maxConcurrent', text) }}
          onReset={() => { props.resetField('maxConcurrent') }}
        />
      </section>
    </SettingsForm>
  )
}
