/** Tell the Host which Session this page shows, while the page stays on screen. */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ClientPresence } from '../protocol.ts'
import { PRESENCE_HEARTBEAT_MS } from '../protocol.ts'

/** Retention source meaning "the main area shows this Session". */
const SHOWN_SOURCE = 'mainView'

/** The Session list slice the reporter reads; `ctx.sessions.list` satisfies it. */
export interface PresenceList {
  getSnapshot(): SessionListState
  subscribe(listener: () => void): () => void
}

/** Sessions the main area currently shows; sidebar panes are not the main area. */
export function shownSessionIds(list: SessionListState): string[] {
  return Object.values(list.byId)
    .filter(row => (row.retainedBy[SHOWN_SOURCE] ?? 0) > 0)
    .map(row => row.id)
}

/** Whether the page is on screen: its tab is visible and its window has focus. */
export function pageVisible(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** Page-scoped identity, so several tabs on different Sessions coexist in Host state. */
export function createClientId(): string {
  // Presence is cosmetic: a runtime without Web Crypto still gets an identity.
  if (typeof globalThis.crypto?.getRandomValues !== 'function') return `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export interface PresenceReporterOptions {
  /** Page identity carrying this reporter's reports. */
  readonly clientId: string
  /** Session list to follow for main-area selection changes. */
  readonly list: PresenceList
  /** Deliver one report; transport failures belong to the caller. */
  readonly send: (presence: ClientPresence) => void
  /** Page-visibility probe; defaults to the real document and window. */
  readonly visible?: () => boolean
}

/**
 * Report this page's shown Session and foreground state, now and on every
 * change, and refresh it on a heartbeat while the page stays visible. Reports
 * that repeat the previous state are dropped, so a quiet page is silent.
 * @param options - page identity, selection source, and delivery.
 * @returns disposer removing every listener and the heartbeat.
 */
export function startPresenceReporter(options: PresenceReporterOptions): () => void {
  const visible = options.visible ?? pageVisible
  const current = (): ClientPresence => ({
    clientId: options.clientId,
    sessionIds: shownSessionIds(options.list.getSnapshot()),
    visible: visible(),
  })
  let reported: string | undefined
  const publish = (refresh: boolean) => {
    const presence = current()
    const encoded = JSON.stringify(presence)
    if (!refresh && encoded === reported) return
    reported = encoded
    options.send(presence)
  }
  publish(false)
  const onPageState = () => { publish(false) }
  document.addEventListener('visibilitychange', onPageState)
  window.addEventListener('focus', onPageState)
  window.addEventListener('blur', onPageState)
  const unsubscribe = options.list.subscribe(onPageState)
  const heartbeat = setInterval(() => { if (visible()) publish(true) }, PRESENCE_HEARTBEAT_MS)
  return () => {
    clearInterval(heartbeat)
    unsubscribe()
    document.removeEventListener('visibilitychange', onPageState)
    window.removeEventListener('focus', onPageState)
    window.removeEventListener('blur', onPageState)
  }
}
