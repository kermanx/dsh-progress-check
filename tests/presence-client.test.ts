// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { PRESENCE_HEARTBEAT_MS } from '../src/protocol.ts'
import { pageVisible, shownSessionIds, startPresenceReporter } from '../src/client/presence.ts'
import type { PresenceList } from '../src/client/presence.ts'

afterEach(() => { vi.useRealTimers() })

interface Row { id: string; mainView?: number }

function stateOf(rows: readonly Row[]): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, {
      id: row.id, displayTitle: row.id, running: true, blank: false, updatedAt: 0,
      retainedBy: row.mainView === undefined ? {} : { mainView: row.mainView },
    }])),
    phase: 'ready', projectionsBySession: {},
  } as unknown as SessionListState
}

function pageList(rows: readonly Row[]) {
  let state = stateOf(rows)
  const listeners = new Set<() => void>()
  const source: PresenceList = {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { source, show: (next: readonly Row[]) => { state = stateOf(next); for (const listener of listeners) listener() } }
}

it('reports the Session the main area shows while the page is visible', () => {
  const { source } = pageList([{ id: 'session-a', mainView: 1 }, { id: 'session-b' }])
  const send = vi.fn()
  const stop = startPresenceReporter({ clientId: 'page', list: source, send, visible: () => true })
  expect(send).toHaveBeenCalledExactlyOnceWith({ clientId: 'page', sessionIds: ['session-a'], visible: true })
  stop()
})

it('marks a page that is not on screen as invisible', () => {
  const { source } = pageList([{ id: 'session-a', mainView: 1 }])
  const send = vi.fn()
  const stop = startPresenceReporter({ clientId: 'page', list: source, send, visible: () => false })
  expect(send).toHaveBeenCalledExactlyOnceWith({ clientId: 'page', sessionIds: ['session-a'], visible: false })
  stop()
})

it('follows the main-area selection and drops repeated states', () => {
  const { source, show } = pageList([{ id: 'session-a', mainView: 1 }])
  const send = vi.fn()
  const stop = startPresenceReporter({ clientId: 'page', list: source, send, visible: () => true })
  window.dispatchEvent(new Event('focus'))
  expect(send).toHaveBeenCalledTimes(1)
  show([{ id: 'session-b', mainView: 1 }])
  expect(send).toHaveBeenLastCalledWith({ clientId: 'page', sessionIds: ['session-b'], visible: true })
  expect(send).toHaveBeenCalledTimes(2)
  show([{ id: 'session-b', mainView: 1 }])
  expect(send).toHaveBeenCalledTimes(2)
  stop()
})

it('refreshes a visible page on the heartbeat and stays silent once hidden', async () => {
  vi.useFakeTimers()
  const { source } = pageList([{ id: 'session-a', mainView: 1 }])
  const send = vi.fn()
  let visible = true
  const stop = startPresenceReporter({ clientId: 'page', list: source, send, visible: () => visible })
  expect(send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
  expect(send).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS)
  expect(send).toHaveBeenCalledTimes(3)
  visible = false
  document.dispatchEvent(new Event('visibilitychange'))
  expect(send).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 3)
  expect(send).toHaveBeenCalledTimes(4)
  stop()
})

it('stops listening and beating after disposal', async () => {
  vi.useFakeTimers()
  const { source, show } = pageList([{ id: 'session-a', mainView: 1 }])
  const send = vi.fn()
  const stop = startPresenceReporter({ clientId: 'page', list: source, send, visible: () => true })
  stop()
  window.dispatchEvent(new Event('focus'))
  show([{ id: 'session-b', mainView: 1 }])
  await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 2)
  expect(send).toHaveBeenCalledTimes(1)
})

it('reports only Sessions the main area retains', () => {
  expect(shownSessionIds(stateOf([{ id: 'session-a', mainView: 1 }, { id: 'session-b' }]))).toEqual(['session-a'])
  expect(shownSessionIds(stateOf([]))).toEqual([])
})

it('treats a visible, focused document as on screen', () => {
  let visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  expect(pageVisible()).toBe(true)
  focus.mockReturnValue(false)
  expect(pageVisible()).toBe(false)
  visibility = 'hidden'
  focus.mockReturnValue(true)
  expect(pageVisible()).toBe(false)
  focus.mockRestore()
})
