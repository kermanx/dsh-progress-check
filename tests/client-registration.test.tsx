// @vitest-environment jsdom
import { createElement, useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { GENERATE_METHOD, PROGRESS_CHANNEL } from '../src/protocol.ts'
import { zh } from '../src/client/locales.ts'
import type { ProgressKey } from '../src/client/locales.ts'

afterEach(cleanup)

it('offers generation in the running Session header without waiting for a completed turn', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const call = vi.fn().mockResolvedValue({ ok: true, value: { seq: 42 } })
  ctx.provide('connection', { rpc: { call } } as never)
  ctx.provide('uiConversation', { events: { register: () => () => {} } } as never)
  ctx.provide('conversation', {} as never)
  ctx.provide('locale', { register: () => () => {} } as never)
  ctx.provide('sessions', { list: createSnapshotStore({ byId: {} }) } as never)
  const owner = ctx.slots.register({ name: 'root', children: {
    'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  try {
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
    const entries = ctx.slots.entries('conversation.session.header.utilities')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    const session = createSnapshotStore({ running: false })
    const pending = Promise.withResolvers<{ ok: boolean; value: { seq: number } }>()
    const useSession = (select: (state: { running: boolean }) => boolean) =>
      select(useSyncExternalStore(session.subscribe, session.getSnapshot))
    render(createElement(entry.component, {
      ...entry.inject?.('session-under-test' as never),
      useSession, t: (key: ProgressKey) => zh[key],
    }))
    expect(screen.queryByRole('button', { name: '生成进展' })).toBeNull()
    act(() => { session.set({ running: true }) })
    call.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: '生成进展' }))
    expect(call).toHaveBeenLastCalledWith(PROGRESS_CHANNEL, GENERATE_METHOD,
      { sessionId: 'session-under-test' }, expect.any(AbortSignal))
    const signal = call.mock.lastCall![3] as AbortSignal
    expect(screen.getByRole('button', { name: '生成中…' }).hasAttribute('disabled')).toBe(true)
    act(() => { session.set({ running: false }) })
    expect(signal.aborted).toBe(true)
    expect(screen.queryByRole('button', { name: '生成中…' })).toBeNull()
    await act(async () => { pending.resolve({ ok: true, value: { seq: 42 } }); await pending.promise })
  } finally {
    cleanup()
    await fiber.dispose()
    owner()
    await ctx.fiber.dispose()
  }
})
