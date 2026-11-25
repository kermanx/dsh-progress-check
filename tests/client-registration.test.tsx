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
import type { ProgressView } from '../src/records.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it('renders at most one floating dock card with a right-side refresh icon button when running', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const focus = vi.fn()
  const call = vi.fn().mockResolvedValue({ ok: true, value: { seq: 42 } })
  ctx.provide('connection', { rpc: { call } } as never)
  ctx.provide('conversation', { input: { for: () => ({ focus }) } } as never)
  ctx.provide('locale', { register: () => () => {} } as never)
  ctx.provide('sessions', {
    list: createSnapshotStore({ byId: {} }),
    binding: () => ({ ctx: {} }),
  } as never)
  const owner = ctx.slots.register({ name: 'root', children: {
    'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    'conversation.input.dock': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  try {
    expect(ctx.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.chat.node')).toHaveLength(0)
    const entries = ctx.slots.entries('conversation.input.dock')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.options).toMatchObject({ id: 'progress-check', order: -10 })

    const projection = createSnapshotStore<ProgressView>(null)
    const session = createSnapshotStore({ running: false })
    const input = createSnapshotStore({ phase: 'plain' })
    const useProjection = () => useSyncExternalStore(projection.subscribe, projection.getSnapshot)
    const useSession = (select: (state: { running: boolean }) => boolean) =>
      select(useSyncExternalStore(session.subscribe, session.getSnapshot))
    const useInput = (select: (state: { phase: string }) => boolean) =>
      select(useSyncExternalStore(input.subscribe, input.getSnapshot))
    let cursor = 0
    const insertText = vi.fn(() => true)
    const persistDraft = vi.fn()
    const inputActions = {
      captureInsertion: () => ({ start: cursor, end: cursor }),
      insertText,
      persistDraft,
    }
    const t = (key: ProgressKey, params?: Record<string, string>) => {
      let text = zh[key]
      if (params !== undefined) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, v)
      return text
    }
    render(createElement(entry.component, {
      ...entry.inject?.('session-under-test' as never),
      useProjection, useSession, useInput, inputActions, t,
    }))
    expect(screen.queryByRole('region', { name: zh.aria })).toBeNull()

    const now = Date.now()
    act(() => {
      projection.set({
        id: 'check-1',
        updatedAt: now,
        stepsAgo: 2,
        needsRefresh: true,
        report: { progress: '第一条进展', uncertainties: [], userActions: ['请确认方案 A'] },
      })
    })
    expect(screen.getAllByRole('region', { name: zh.aria })).toHaveLength(1)
    expect(screen.getByText('第一条进展')).toBeTruthy()
    expect(screen.getByText('<1 分钟前')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '生成进展' })).toBeNull()
    expect(screen.getByRole('region', { name: zh.aria }).getAttribute('data-stale-updating')).toBeNull()
    expect(document.querySelector('.dsh-progress-check-bar')).toBeNull()

    // While running, the refresh icon button appears on the right side of the card.
    act(() => { session.set({ running: true }) })
    const pending = Promise.withResolvers<{ ok: boolean; value: { seq: number } }>()
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

    // A newer report replaces the floating card in place instead of adding a second card.
    act(() => {
      projection.set({
        id: 'check-2',
        updatedAt: now - 120_000,
        stepsAgo: 0,
        needsRefresh: false,
        report: { progress: '第二条进展', uncertainties: [], userActions: ['请确认方案 B'] },
      })
    })
    expect(screen.getAllByRole('region', { name: zh.aria })).toHaveLength(1)
    expect(screen.queryByText('第一条进展')).toBeNull()
    expect(screen.getByText('第二条进展')).toBeTruthy()
    expect(screen.getByText('2 分钟前')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: zh.reply }))
    expect(insertText).toHaveBeenLastCalledWith('关于「请确认方案 B」：', { start: 0, end: 0 })
    expect(persistDraft).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()

    cursor = 5
    fireEvent.click(screen.getByRole('button', { name: zh.reply }))
    expect(insertText).toHaveBeenLastCalledWith('\n关于「请确认方案 B」：', { start: 5, end: 5 })
  } finally {
    cleanup()
    await fiber.dispose()
    owner()
    await ctx.fiber.dispose()
  }
})
