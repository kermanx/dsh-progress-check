/** Browser contribution: durable progress records and a compact localized chat card. */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime, PropsStore, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { progressDefinition } from './definition.ts'
import { Card } from './Card.tsx'
import { createExpansionStore } from './expansion.ts'
import { GenerateAction, type GenerateActionProps } from './GenerateAction.tsx'
import { createClientId, startPresenceReporter } from './presence.ts'
import { GENERATE_METHOD, PRESENCE_METHOD, PROGRESS_CHANNEL, generateResponseSchema } from '../protocol.ts'
import { en, zh } from './locales.ts'
import type { ProgressKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { progressCheck: ProgressKey }
}
/** Services provided by the Web conversation UI. */
export const inject = ['slots', 'uiConversation', 'conversation', 'sessions', 'locale', 'connection']
/** Theme tokens follow the host; text size follows the conversation setting. */
const styles = `
/* Stick the direct flow seat so the transcript column is its containing block. */
[data-chat-flow] > [data-chat-flow-kind="progress-check"]:not(:has(~ [data-chat-flow-kind="progress-check"])) { position:sticky; top:0; z-index:7; background:var(--dsw-alias-bg-base); }
.dsh-progress-check { display:grid; grid-template-columns:minmax(0,1fr) 28px; gap:8px; align-items:start; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); box-shadow:var(--dsw-shadow-lv3); padding:12px 16px; font-size:var(--dsh-content-font-size,14px); line-height:1.65; overflow-wrap:anywhere; }
.dsh-progress-check dl { min-width:0; display:grid; grid-template-columns:max-content minmax(0,1fr); gap:8px 16px; margin:0; }
.dsh-progress-check dt { color:var(--dsw-alias-label-secondary); font-weight:400; }
.dsh-progress-check dd { min-width:0; margin:0; white-space:pre-line; }
.dsh-progress-check dd > div + div { margin-top:6px; }
.dsh-progress-check[data-expanded="false"] .dsh-progress-check-progress { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-progress-check .dsh-progress-check-toggle { width:28px; padding:0; color:var(--dsw-alias-label-secondary); }
.dsh-progress-check-reply { border:0; padding:0; margin-left:4px; background:none; color:var(--dsw-alias-link); font:inherit; text-underline-offset:3px; cursor:pointer; }
.dsh-progress-check-reply:hover { text-decoration:underline; }
.dsh-progress-check-reply:disabled { opacity:.45; cursor:default; }
.dsh-progress-check-reply:focus-visible { outline:2px solid currentColor; outline-offset:3px; }
.dsh-progress-check-generate { flex:none; padding:0; border:0; background:none; color:inherit; font:inherit; white-space:nowrap; cursor:pointer; text-underline-offset:3px; }
.dsh-progress-check-generate:hover:not(:disabled) { text-decoration:underline; }
.dsh-progress-check-generate:disabled { opacity:.65; cursor:default; }
.dsh-progress-check-generate:focus-visible { outline:2px solid currentColor; outline-offset:3px; }
`
type SlotProps = PropsRuntime<'conversation.chat.node', 'progress-check'> & PropsLocale<'progressCheck'>
  & PropsStore<ReturnType<typeof createExpansionStore>> & { focusComposer(): void }

/**
 * Register the history reader, labels, and reply action for each session.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.uiConversation.events.register(progressDefinition)
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
      key: sequence, text: t('generateFailed'), onDone: () => { failure.set(null) },
    })
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'progress-check-failure', locale: 'progressCheck',
    inject: () => ({ hooks: { failure } }),
  }, FailureToast))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: 'progress-check', locale: 'progressCheck',
    inject: sessionId => ({
      generate: async (signal: AbortSignal) => {
        const result = await connection.rpc.call(PROGRESS_CHANNEL, GENERATE_METHOD, { sessionId }, signal)
        return result.ok && generateResponseSchema.safeParse(result.value).success
      },
      onFailure,
    }),
  }, ({ turn, ...props }: PropsRuntime<'conversation.chat.turnTail'> & GenerateActionProps) =>
    turn.status === 'open' ? createElement(GenerateAction, props) : null))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = styles
    document.head.append(style)
    return () => style.remove()
  })
  const View = ({ node, t, useInput, inputActions, focusComposer, useStore, actions }: SlotProps) => {
    const disabled = useInput(state => state.phase !== 'plain')
    const expanded = useStore(state => state.expanded)
    return createElement(Card, {
      report: node.data, t, disabled, expanded, onToggle: actions.toggle,
      onReply: (question: string) => {
        const span = inputActions.captureInsertion()
        if (inputActions.insertText(`\n${t('replyTo', { question })}`, { ...span, end: span.start })) {
          inputActions.persistDraft()
          focusComposer()
        }
      },
    })
  }
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'progress-check', locale: 'progressCheck', store: createExpansionStore(),
    inject: sessionId => ({ focusComposer: () => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding !== undefined) ctx.conversation.input.for(binding.ctx).focus()
    } }),
  }, View))
}
