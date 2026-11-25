// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Card } from '../src/client/Card.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { ProgressKey } from '../src/client/locales.ts'
import { readResult } from '../src/records.ts'

const report = { progress: '正在完成会话保存修复。\n下一步检查恢复后的会话内容。', uncertainties: ['旧格式应统一迁移还是保留独立兼容层，目前无法确定。'], userActions: ['请并行确认仍在使用的旧格式版本范围，帮助缩小兼容验证范围。'], links: {} }
const formatWith = (dict: typeof zh) => (key: ProgressKey, params?: Record<string, string>) => {
  let text = dict[key]
  if (params !== undefined) for (const [k, v] of Object.entries(params)) text = text.replace(`{${k}}`, v)
  return text
}
const t = formatWith(zh)
const FIXED_TIME = 1_700_000_000_000

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
})

it('shows the three answers, stable age label, and puts Reply beside its question', () => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_TIME)
  const reply = vi.fn()
  const { container } = render(<Card report={report} updatedAt={FIXED_TIME} stepsAgo={0} t={t} disabled={false} onReply={reply} />)
  expect(container.innerHTML).toMatchSnapshot()
  expect(container.querySelector('details')).toBeNull()
  expect(screen.getAllByRole('term')).toHaveLength(3)
  expect(screen.getAllByRole('definition')).toHaveLength(3)
  expect(container.querySelector('ul, ol')).toBeNull()
  expect(screen.getByText('<1 分钟前')).toBeTruthy()
  const button = screen.getByRole('button', { name: '回复' })
  expect(button.parentElement?.textContent).toContain(report.userActions[0])
  fireEvent.click(button)
  expect(reply).toHaveBeenCalledExactlyOnceWith(report.userActions[0])
})

it('omits empty answers and the reply action when there is nothing for the user to do', () => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_TIME)
  const { container } = render(<Card report={{ ...report, uncertainties: [], userActions: [] }} updatedAt={FIXED_TIME} stepsAgo={0} t={t} disabled={false} onReply={vi.fn()} />)
  expect(container.innerHTML).toMatchSnapshot()
  expect(screen.queryByRole('button', { name: '回复' })).toBeNull()
  expect(screen.getAllByRole('term')).toHaveLength(1)
  expect(screen.getByRole('term').textContent).toBe(zh.progress)
  expect(screen.getAllByRole('definition')).toHaveLength(1)
  expect(screen.queryByText(zh.uncertainties)).toBeNull()
  expect(screen.queryByText(zh.userActions)).toBeNull()
})

it('keeps the answers that have content and drops only the empty one', () => {
  const withoutUncertainties = render(<Card report={{ ...report, uncertainties: [] }} updatedAt={Date.now()} stepsAgo={0} t={t} disabled={false} onReply={vi.fn()} />)
  expect(screen.queryByText(zh.uncertainties)).toBeNull()
  expect(screen.getByText(zh.userActions)).not.toBeNull()
  expect(screen.getByRole('button', { name: '回复' })).not.toBeNull()
  withoutUncertainties.unmount()
  render(<Card report={{ ...report, userActions: [] }} updatedAt={Date.now()} stepsAgo={0} t={t} disabled={false} onReply={vi.fn()} />)
  expect(screen.getByText(zh.uncertainties)).not.toBeNull()
  expect(screen.queryByText(zh.userActions)).toBeNull()
  expect(screen.queryByRole('button', { name: '回复' })).toBeNull()
})

it('escapes model text and rejects malformed persisted reports', () => {
  render(<Card report={{ ...report, progress: '<img src=x onerror=alert(1)>' }} updatedAt={Date.now()} stepsAgo={0} t={t} disabled={true} onReply={vi.fn()} />)
  expect(document.querySelector('img')).toBeNull()
  expect(readResult({ type: 'plugin:progress-check/result', ignorable: true, data: { report: {} } })).toBeUndefined()
})

it('updates the relative age only at minute/hour bucket boundaries without flickering', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_TIME)
  render(<Card report={{ ...report, uncertainties: [], userActions: [] }} updatedAt={FIXED_TIME} stepsAgo={0} t={formatWith(en)} disabled={false} onReply={vi.fn()} />)
  expect(screen.getByText('<1min ago')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(59_000) })
  expect(screen.getByText('<1min ago')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(screen.getByText('1min ago')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(screen.getByText('2min ago')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(screen.getByText('3min ago')).toBeTruthy()
  for (let i = 0; i < 57; i++) await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(screen.getByText('1h ago')).toBeTruthy()
})

it('toggles between relative time and steps ago on click and remembers the choice', () => {
  const first = render(<Card report={{ ...report, uncertainties: [], userActions: [] }} updatedAt={Date.now()} stepsAgo={3} t={t} disabled={false} onReply={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '<1 分钟前' }))
  expect(screen.getByRole('button', { name: '3 步前' })).toBeTruthy()
  first.unmount()

  render(<Card report={{ ...report, uncertainties: [], userActions: [] }} updatedAt={Date.now()} stepsAgo={4} t={t} disabled={false} onReply={vi.fn()} />)
  expect(screen.getByRole('button', { name: '4 步前' })).toBeTruthy()
})

it('renders key links when present and omits the section when empty', () => {
  const { unmount } = render(<Card report={{ ...report, uncertainties: [], userActions: [], links: { 'PR #42': 'https://github.com/org/repo/pull/42' } }} updatedAt={Date.now()} stepsAgo={0} t={t} disabled={false} onReply={vi.fn()} />)
  expect(screen.getByText('重点链接')).toBeTruthy()
  const link = screen.getByRole('link', { name: 'PR #42' }) as HTMLAnchorElement
  expect(link.href).toBe('https://github.com/org/repo/pull/42')
  unmount()

  render(<Card report={{ ...report, uncertainties: [], userActions: [], links: {} }} updatedAt={Date.now()} stepsAgo={0} t={t} disabled={false} onReply={vi.fn()} />)
  expect(screen.queryByText('重点链接')).toBeNull()
})
