/** Host view of which Sessions a browser page is actually showing. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PRESENCE_TTL_MS } from './protocol.ts'
import type { ClientPresence } from './protocol.ts'

interface ClientState {
  sessionIds: ReadonlySet<string>
  visible: boolean
  at: number
}

/**
 * Latest report per browser page. A report carries no lifetime of its own:
 * pages refresh it while they stay in the foreground, so a closed tab expires
 * instead of leaving its Session "shown" forever.
 */
export class PresenceRegistry {
  private readonly clients = new Map<string, ClientState>()

  /**
   * Record one page's report, replacing that page's previous statement.
   * @param presence - validated report from the page's current state.
   * @param now - clock override for tests.
   */
  report(presence: ClientPresence, now: number = Date.now()): void {
    this.clients.set(presence.clientId, {
      sessionIds: new Set(presence.sessionIds), visible: presence.visible, at: now,
    })
  }

  /**
   * Whether any page still in the foreground shows this Session. Expiry is
   * evaluated on read, so a stale report stops counting even with no traffic.
   * @param sessionId - Session to test.
   * @param now - clock override for tests.
   * @returns true while at least one fresh, visible report names the Session.
   */
  watched(sessionId: SessionId, now: number = Date.now()): boolean {
    let watched = false
    for (const [clientId, state] of this.clients) {
      if (now - state.at > PRESENCE_TTL_MS) {
        this.clients.delete(clientId)
        continue
      }
      if (state.visible && state.sessionIds.has(sessionId)) watched = true
    }
    return watched
  }

  /** Forget every report; unload must not leave Host state behind. */
  clear(): void {
    this.clients.clear()
  }
}
