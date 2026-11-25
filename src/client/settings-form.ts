/** Staged configuration form over this plugin's profile row. */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  SettingsFieldSpec, SettingsFieldState, SettingsFormActions, SettingsFormScope, SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SettingsFormModel } from '@deepseek-ai/dsh-client-ui-primitives'

/** The configuration fields this page edits — the whole Config section. */
export interface ProgressSettings {
  intervalMs?: number
  intervalSteps?: number
  maxConcurrent?: number
  timeoutMs?: number
  maxResponseBytes?: number
  maxParseRetries?: number
  includeSubagents?: boolean
  onlyWhenVisible?: boolean
  refreshOnTurnEnd?: boolean
}

/** Current drafts and the shared form status. */
export interface ProgressSettingsState extends SettingsFormShell {
  intervalMs: SettingsFieldState
  intervalSteps: SettingsFieldState
  maxConcurrent: SettingsFieldState
  timeoutMs: SettingsFieldState
  maxResponseBytes: SettingsFieldState
  maxParseRetries: SettingsFieldState
  includeSubagents: SettingsFieldState
  onlyWhenVisible: SettingsFieldState
  refreshOnTurnEnd: SettingsFieldState
}

/** Registration-side form observable and edit callbacks. */
export interface ProgressSettingsFace extends SettingsFormActions {
  hooks: { progressSettings: SnapshotStore<ProgressSettingsState> }
}

/**
 * A whole-number field. An empty draft clears the field back to the
 * composition layer; any other draft outside the bounds blocks the save.
 * @param field - field name inside the namespace section.
 * @param minimum - smallest accepted value.
 * @param maximum - largest accepted value, when the Host bounds the field.
 * @returns the field's conversion spec.
 */
function settingsIntegerField(field: string, minimum: number, maximum?: number): SettingsFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      const bounded = maximum === undefined || parsed <= maximum
      return Number.isSafeInteger(parsed) && parsed >= minimum && bounded ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/**
 * A two-state field staged as text so one save writes it with the rest of the
 * form. The switch never produces an invalid draft.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
function settingsBooleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => {
      if (value === true) return 'true'
      return value === false ? 'false' : ''
    },
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === 'true') return { kind: 'set', value: true }
      return trimmed === 'false' ? { kind: 'set', value: false } : undefined
    },
  }
}

/** Stages configuration edits until the reader saves them. */
export class ProgressSettingsForm {
  private readonly form: SettingsFormModel<ProgressSettings>
  private readonly state: SnapshotStore<ProgressSettingsState>

  /** @param scope - Host-backed configuration form for this plugin's row. */
  constructor(scope: SettingsFormScope<ProgressSettings>) {
    this.form = new SettingsFormModel(scope, [
      settingsIntegerField('intervalMs', 1),
      settingsIntegerField('intervalSteps', 1),
      settingsBooleanField('onlyWhenVisible'),
      settingsBooleanField('includeSubagents'),
      settingsBooleanField('refreshOnTurnEnd'),
      settingsIntegerField('timeoutMs', 1),
      settingsIntegerField('maxResponseBytes', 1),
      settingsIntegerField('maxParseRetries', 0, 3),
      settingsIntegerField('maxConcurrent', 1),
    ])
    this.state = this.form.bind(() => ({
      ...this.form.shell(),
      intervalMs: this.form.field('intervalMs'),
      intervalSteps: this.form.field('intervalSteps'),
      maxConcurrent: this.form.field('maxConcurrent'),
      timeoutMs: this.form.field('timeoutMs'),
      maxResponseBytes: this.form.field('maxResponseBytes'),
      maxParseRetries: this.form.field('maxParseRetries'),
      includeSubagents: this.form.field('includeSubagents'),
      onlyWhenVisible: this.form.field('onlyWhenVisible'),
      refreshOnTurnEnd: this.form.field('refreshOnTurnEnd'),
    }))
  }

  /**
   * Build the registration face the page's slot entry injects.
   * @returns the form snapshot and its shared edit/save actions.
   */
  inject(): ProgressSettingsFace {
    return { hooks: { progressSettings: this.state }, ...this.form.actions() }
  }

  /** Release the accepted-value subscription. */
  dispose(): void { this.form.dispose() }
}
