/** Browser contribution: floating latest-progress dock card, manual check, and settings UI. */
import { createElement, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the Plugins page's configuration slots and the shared settings form service.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '../records.ts'
import { Card } from './Card.tsx'
import { GenerateAction, type GenerateActionProps } from './GenerateAction.tsx'
import { createClientId, startPresenceReporter } from './presence.ts'
import { GENERATE_METHOD, PRESENCE_METHOD, PROGRESS_CHANNEL, PROGRESS_ENTRY_ID, generateResponseSchema } from '../protocol.ts'
import { en, zh } from './locales.ts'
import type { ProgressKey } from './locales.ts'
import { ProgressSettingsForm } from './settings-form.ts'
import type { ProgressSettings } from './settings-form.ts'
import { ProgressSettingsCard } from './settings.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { progressCheck: ProgressKey }
}
/** Bundle package whose Plugins-page configuration this plugin owns. */
const BUNDLE_PACKAGE = '@kermanx/dsh-progress-check'
/** Services provided by the Web conversation UI. */
export const inject = ['slots', 'conversation', 'sessions', 'locale', 'connection']
/** Theme tokens follow the host; floating dock card matches Todo/Goal above the composer. */
const styles = `
.dsh-progress-check { position:relative; overflow:hidden; box-sizing:border-box; flex:none; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:start; width:calc(100% - 2 * var(--dsh-composer-side-clearance) - 4 * var(--dsh-composer-dock-inset)); max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset)); margin:0 auto; border:0; --dsw-elevation-stroke-color:var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-lg); background:var(--dsw-specific-menu); backdrop-filter:var(--dsw-menu-backdrop-filter); box-shadow:var(--dsw-elevation-panel); padding:10px 14px; color:var(--dsw-alias-label-primary); font-size:var(--dsh-content-font-size-secondary,13px); line-height:1.55; overflow-wrap:anywhere; }
.dsh-progress-check[data-stale-updating="true"] dl { opacity:.55; transition:opacity 150ms ease; }
.dsh-progress-check-bar { position:absolute; top:0; left:0; right:0; height:2px; overflow:hidden; background:var(--dsw-alias-border-l2); pointer-events:none; }
.dsh-progress-check-bar::after { content:''; position:absolute; top:0; bottom:0; width:38%; border-radius:999px; background:var(--dsw-alias-label-tertiary); animation:dsh-progress-check-indeterminate 1.4s cubic-bezier(.4,0,.2,1) infinite; }
@keyframes dsh-progress-check-indeterminate { 0% { left:-38%; } 100% { left:100%; } }
@media (prefers-reduced-motion: reduce) { .dsh-progress-check-bar::after { left:0; width:100%; opacity:.5; animation:none; } }
.dsh-progress-check dl { min-width:0; display:grid; grid-template-columns:max-content minmax(0,1fr); gap:6px 14px; margin:0; }
.dsh-progress-check dt { color:var(--dsw-alias-label-secondary); font-weight:500; }
.dsh-progress-check dd { min-width:0; margin:0; white-space:pre-line; }
.dsh-progress-check dd > div + div { margin-top:6px; }
.dsh-progress-check-actions { display:flex; align-items:center; gap:6px; flex:none; }
.dsh-progress-check-time { border:0; padding:0; background:none; color:var(--dsw-alias-label-tertiary); font:inherit; font-size:11px; line-height:1.5; font-variant-numeric:tabular-nums; white-space:nowrap; cursor:pointer; }
.dsh-progress-check-time:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:2px; }
.dsh-progress-check-links { display:flex; flex-wrap:wrap; gap:4px 12px; align-items:center; }
.dsh-progress-check-link { color:var(--dsw-alias-link); text-decoration:none; text-underline-offset:3px; white-space:nowrap; }
.dsh-progress-check-link:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:3px; }
.dsh-progress-check-reply { border:0; padding:0; margin-left:4px; background:none; color:var(--dsw-alias-link); font:inherit; text-underline-offset:3px; cursor:pointer; }
.dsh-progress-check-reply:disabled { opacity:.45; cursor:default; }
.dsh-progress-check-reply:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:3px; }
.dsh-progress-check .dsh-progress-check-generate { width:24px; height:24px; padding:0; color:var(--dsw-alias-label-secondary); }
.dsh-progress-check-settings-note { margin:0 0 8px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.6; }
.dsh-progress-check-settings-section { display:flex; flex-direction:column; margin:0 0 20px; }
.dsh-progress-check-settings-section:last-of-type { margin-bottom:8px; }
.dsh-progress-check-settings-heading { margin:0 0 4px; color:var(--dsw-alias-label-primary); font-size:14px; font-weight:500; line-height:1.5; }
.dsh-progress-check-settings-toggle { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px 16px; align-items:start; padding:12px 0; border-top:0.5px solid var(--dsw-alias-border-l2); }
.dsh-progress-check-settings-toggle-copy { display:grid; gap:6px; min-width:0; }
.dsh-progress-check-settings-toggle-label { color:var(--dsw-alias-label-primary); font-size:13px; font-weight:500; line-height:1.5; }
.dsh-progress-check-settings-toggle-hint { margin:0; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:1.5; }
.dsh-progress-check-settings-toggle-control { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; align-items:center; min-height:24px; }
.dsh-progress-check-settings-badges { display:inline-flex; gap:8px; align-items:center; }
.dsh-progress-check-settings-reset { border:0; background:none; padding:0; font:inherit; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dsh-progress-check-settings-reset:disabled { cursor:default; opacity:.45; }
.dsh-progress-check-settings-reset:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:2px; }
@media (hover: hover) {
  .dsh-progress-check-time:hover { color:var(--dsw-alias-label-secondary); }
  .dsh-progress-check-link:hover { text-decoration:underline; }
  .dsh-progress-check-reply:hover { text-decoration:underline; }
  .dsh-progress-check-settings-reset:hover:not(:disabled) { color:var(--dsw-alias-label-primary); }
}
`
type DockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'progressCheck'>
  & { focusComposer(): void; generate(signal: AbortSignal): Promise<boolean>; onFailure(): void }

/**
 * Register the floating latest-progress dock card, manual check action, presence reporter, and settings page.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register('progressCheck', { zh, en }))
  // The Host only generates automatic cards while a foreground page shows the
  // Session, so this page states what it shows whenever that can change.
  ctx.effect(() => {
    const clientId = createClientId()
    return startPresenceReporter({
      clientId, list: ctx.sessions.list,
      send: (presence) => { void connection.rpc.call(PROGRESS_CHANNEL, PRESENCE_METHOD, presence).catch(() => {}) },
    })
  })
  const failure = createSnapshotStore<number | null>(null)
  let failureSequence = 0
  const onFailure = () => { failure.set(++failureSequence) }
  const FailureToast = ({ t, useFailure }: PropsLocale<'progressCheck'> & { useFailure: SnapshotSelectorHook<number | null> }) => {
    const sequence = useFailure(value => value)
    return sequence === null ? null : createElement(Toast, {
      key: sequence, icon: createElement(IconWarningOutlineRegular), text: t('generateFailed'), onDone: () => { failure.set(null) },
    })
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'progress-check-failure', locale: 'progressCheck',
    inject: () => ({ hooks: { failure } }),
  }, FailureToast))
  // This plugin ships its own configuration page, so nothing builds one from
  // its schema. The form exists while the Host serves the profile row.
  const refreshOnTurnEndStore = createSnapshotStore(false)
  ctx.inject(['configForms'], (scope) => {
    const form = scope.configForms.get<ProgressSettings>(PROGRESS_ENTRY_ID)
    const settings = new ProgressSettingsForm(form)
    const syncRefresh = () => { refreshOnTurnEndStore.set(form.getSnapshot().value?.refreshOnTurnEnd === true) }
    syncRefresh()
    scope.effect(() => form.subscribe(syncRefresh), 'progress-check: refreshOnTurnEnd state')
    scope.effect(() => () => { settings.dispose() }, 'progress-check: settings form')
    scope.effect(() => scope.configForms.whileServed([PROGRESS_ENTRY_ID], () => scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
      name: 'plugins.bundle.config', key: BUNDLE_PACKAGE, locale: 'progressCheck',
      inject: () => settings.inject(),
    }, ProgressSettingsCard))), 'progress-check: settings page')
  })
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = styles
    document.head.append(style)
    return () => style.remove()
  })
  const DockView = ({ useProjection, useSession, t, useInput, inputActions, focusComposer, generate, onFailure }: DockProps) => {
    const view = useProjection('progress-check')
    const running = useSession(session => session.running)
    const refreshOnTurnEnd = useSyncExternalStore(refreshOnTurnEndStore.subscribe, refreshOnTurnEndStore.getSnapshot)
    const disabled = useInput(state => state.phase !== 'plain')
    if (view == null) return null
    return createElement(Card, {
      report: view.report, updatedAt: view.updatedAt, stepsAgo: view.stepsAgo,
      staleUpdating: refreshOnTurnEnd && !running && view.needsRefresh, t, disabled,
      action: running ? createElement(GenerateAction, { t, generate, onFailure }) : null,
      onReply: (question: string) => {
        const span = inputActions.captureInsertion()
        const prefix = span.start === 0 ? '' : '\n'
        if (inputActions.insertText(`${prefix}${t('replyTo', { question })}`, { ...span, end: span.start })) {
          inputActions.persistDraft()
          focusComposer()
        }
      },
    })
  }
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'progress-check', order: -10, locale: 'progressCheck',
    inject: sessionId => ({
      focusComposer: () => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding !== undefined) ctx.conversation.input.for(binding.ctx).focus()
      },
      generate: async (signal: AbortSignal) => {
        const result = await connection.rpc.call(PROGRESS_CHANNEL, GENERATE_METHOD, { sessionId }, signal)
        return result.ok && generateResponseSchema.safeParse(result.value).success
      },
      onFailure,
    }),
  }, DockView))
}
