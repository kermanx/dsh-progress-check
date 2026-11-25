// @vitest-environment jsdom
/** The plugin's configuration page on the Plugins page. */
import { createElement, useSyncExternalStore, type ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'
import type { ProgressKey } from '../src/client/locales.ts'
import type { ProgressSettings, ProgressSettingsState } from '../src/client/settings-form.ts'

afterEach(cleanup)

const DEFAULTS: Required<ProgressSettings> = {
  intervalMs: 60000, intervalSteps: 5, maxConcurrent: 1, timeoutMs: 120000,
  maxResponseBytes: 262144, maxParseRetries: 3, includeSubagents: false, onlyWhenVisible: true, refreshOnTurnEnd: false,
}

interface FakeScope {
  form: ConfigForm<ProgressSettings>
  mutate: ConfigForm<ProgressSettings>['mutate']
  publish(next: Partial<ConfigFormSnapshot<ProgressSettings>>): void
}

/** A shareable configuration form the test drives directly, like the Host mirror does. */
function fakeScope(): FakeScope {
  let snapshot: ConfigFormSnapshot<ProgressSettings> = {
    status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false,
  }
  const listeners = new Set<() => void>()
  const mutate = vi.fn<ConfigForm<ProgressSettings>['mutate']>(async () => true)
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate,
    set: vi.fn(async () => true),
    unset: vi.fn(async () => true),
  } as unknown as ConfigForm<ProgressSettings>
  return {
    form,
    mutate,
    publish: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Mount the browser plugin against a fake settings service whose watched
 * namespace registration can be withheld.
 * @param options - `served: false` keeps `whileServed` from registering.
 */
async function setupSettings(options: { served?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('connection', { rpc: { call: vi.fn(async () => ({ ok: false })) } } as never)
  ctx.provide('conversation', {} as never)
  ctx.provide('locale', { register: () => () => {} } as never)
  ctx.provide('sessions', { list: createSnapshotStore({ byId: {} }) } as never)
  const scope = fakeScope()
  const watched: string[][] = []
  const whileServed = vi.fn((namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
    watched.push([...namespaces])
    return options.served === false ? () => {} : register(new Set(namespaces))
  })
  ctx.provide('configForms', { get: () => scope.form, whileServed } as never)
  const owner = ctx.slots.register({ name: 'root', children: {
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
  } } as never, () => null)
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  const dispose = async () => {
    cleanup()
    await fiber.dispose()
    owner()
    await ctx.fiber.dispose()
  }
  return { ctx, scope, whileServed, watched, dispose }
}

type Fixture = Awaited<ReturnType<typeof setupSettings>>

/** Render the registered page with its injected face and the real dictionary. */
function renderCard(fixture: Fixture) {
  const entry = fixture.ctx.slots.entries('plugins.bundle.config')[0]!
  const props = entry.inject!() as Record<string, unknown>
  const store = (props.hooks as { progressSettings: SnapshotStore<ProgressSettingsState> }).progressSettings
  const useProgressSettings = (select: (state: ProgressSettingsState) => ProgressSettingsState) =>
    select(useSyncExternalStore(store.subscribe, store.getSnapshot))
  return render(createElement(entry.component as ComponentType<Record<string, unknown>>, {
    view: 'page', t: (key: ProgressKey) => zh[key], useProgressSettings, ...props,
  }))
}

/** Serve resolved values, optionally with a user layer marking fields overridden. */
function serve(fixture: Fixture, user: Record<string, unknown> = {}, value: Required<ProgressSettings> = DEFAULTS) {
  fixture.scope.publish({
    status: 'ready', value, base: DEFAULTS, user, revision: 7, writable: true,
  })
}
const saveButton = () => screen.getByRole('button', { name: '保存' }) as HTMLButtonElement

it('registers one configuration page for the bundle while the Host serves its form', async () => {
  const fixture = await setupSettings()
  try {
    await vi.waitFor(() => { expect(fixture.ctx.slots.entries('plugins.bundle.config')).toHaveLength(1) })
    const entry = fixture.ctx.slots.entries('plugins.bundle.config')[0]!
    expect(entry.options).toMatchObject({ key: '@kermanx/dsh-progress-check' })
    expect(entry.locale).toBe('progressCheck')
    expect(fixture.watched).toEqual([['progress-check']])
    expect(fixture.ctx.slots.entries('plugins.bundle.config')[0]!.inject!()).toHaveProperty('hooks.progressSettings')
  } finally { await fixture.dispose() }
})

it('shows no configuration page when the Host serves no form for the entry', async () => {
  const fixture = await setupSettings({ served: false })
  try {
    expect(fixture.watched).toEqual([['progress-check']])
    expect(fixture.ctx.slots.entries('plugins.bundle.config')).toHaveLength(0)
  } finally { await fixture.dispose() }
})

it('renders the served values and the deployment copy', async () => {
  const fixture = await setupSettings()
  try {
    serve(fixture)
    renderCard(fixture)
    expect((screen.getByLabelText('生成间隔（毫秒）') as HTMLInputElement).value).toBe('60000')
    expect((screen.getByLabelText('最少新增步数') as HTMLInputElement).value).toBe('5')
    expect((screen.getByLabelText('并发生成上限') as HTMLInputElement).value).toBe('1')
    expect(screen.getByRole('switch', { name: '仅在被查看时生成' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: '为子智能体会话生成' }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('保存后立即生效，无需重启；配置写入当前 profile 的 patch 文件。')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
  } finally { await fixture.dispose() }
})

it('stages an edit and saves it with the revision the draft started from', async () => {
  const fixture = await setupSettings()
  try {
    serve(fixture)
    renderCard(fixture)
    fireEvent.change(screen.getByLabelText('生成间隔（毫秒）'), { target: { value: '30000' } })
    expect(saveButton().disabled).toBe(false)
    await act(async () => { fireEvent.click(saveButton()) })
    expect(fixture.scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['intervalMs'], value: 30000 }], 7)
  } finally { await fixture.dispose() }
})

it('saves a switch with the same form and cannot produce an invalid draft', async () => {
  const fixture = await setupSettings()
  try {
    serve(fixture)
    renderCard(fixture)
    const toggle = screen.getByRole('switch', { name: '为子智能体会话生成' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => { fireEvent.click(saveButton()) })
    expect(fixture.scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['includeSubagents'], value: true }], 7)
  } finally { await fixture.dispose() }
})

it('marks an overridden field and stages a reset back to the composition default', async () => {
  const fixture = await setupSettings()
  try {
    serve(fixture, { intervalMs: 30000 }, { ...DEFAULTS, intervalMs: 30000 })
    renderCard(fixture)
    expect(screen.getByText('已修改')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect((screen.getByLabelText('生成间隔（毫秒）') as HTMLInputElement).value).toBe('60000')
    await act(async () => { fireEvent.click(saveButton()) })
    expect(fixture.scope.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['intervalMs'] }], 7)
  } finally { await fixture.dispose() }
})

it('blocks saving a draft that is not a whole number', async () => {
  const fixture = await setupSettings()
  try {
    serve(fixture)
    renderCard(fixture)
    fireEvent.change(screen.getByLabelText('生成间隔（毫秒）'), { target: { value: '1.5' } })
    expect(screen.getByText('请填写有效的整数。')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
  } finally { await fixture.dispose() }
})

it('says so in place of the form while the Host serves nothing', async () => {
  const fixture = await setupSettings()
  try {
    renderCard(fixture)
    expect(screen.getByText('当前部署未提供可编辑的插件配置。')).toBeTruthy()
  } finally { await fixture.dispose() }
})
