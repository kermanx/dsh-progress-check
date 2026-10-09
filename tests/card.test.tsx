// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { Card } from '../src/client/Card.tsx'
import { createExpansionStore } from '../src/client/expansion.ts'
import { zh } from '../src/client/locales.ts'
import type { ProgressKey } from '../src/client/locales.ts'
import { readResult } from '../src/records.ts'

const report = { progress: '正在完成会话保存修复。\n正在验证旧格式读取和恢复。\n下一步检查恢复后的会话内容。', uncertainties: ['旧格式应统一迁移还是保留独立兼容层，目前无法确定。'], userActions: ['请并行确认仍在使用的旧格式版本范围，帮助缩小兼容验证范围。'] }
const t = (key: ProgressKey) => zh[key]
const disclosure = { expanded: true, onToggle: vi.fn() }
afterEach(cleanup)
it('shows the three answers when expanded and puts Reply beside its question', () => {
  const reply = vi.fn()
  const { container } = render(<Card report={report} t={t} disabled={false} onReply={reply} {...disclosure} />)
  expect(container.innerHTML).toMatchSnapshot()
  expect(container.querySelector('details')).toBeNull()
  expect(screen.getAllByRole('term')).toHaveLength(3)
  expect(screen.getAllByRole('definition')).toHaveLength(3)
  expect(container.querySelector('ul, ol')).toBeNull()
  const button = screen.getByRole('button', { name: '回复' })
  expect(button.parentElement?.textContent).toContain(report.userActions[0])
  fireEvent.click(button)
  expect(reply).toHaveBeenCalledExactlyOnceWith(report.userActions[0])
})
it('omits empty answers and the reply action when there is nothing for the user to do', () => {
  const { container } = render(<Card report={{ ...report, uncertainties: [], userActions: [] }} t={t} disabled={false} onReply={vi.fn()} {...disclosure} />)
  expect(container.innerHTML).toMatchSnapshot()
  expect(screen.queryByRole('button', { name: '回复' })).toBeNull()
  expect(screen.getAllByRole('term')).toHaveLength(1)
  expect(screen.getByRole('term').textContent).toBe(zh.progress)
  expect(screen.getAllByRole('definition')).toHaveLength(1)
  expect(screen.queryByText(zh.uncertainties)).toBeNull()
  expect(screen.queryByText(zh.userActions)).toBeNull()
})

it('keeps the answers that have content and drops only the empty one', () => {
  const withoutUncertainties = render(<Card report={{ ...report, uncertainties: [] }} t={t} disabled={false} onReply={vi.fn()} {...disclosure} />)
  expect(screen.queryByText(zh.uncertainties)).toBeNull()
  expect(screen.getByText(zh.userActions)).not.toBeNull()
  expect(screen.getByRole('button', { name: '回复' })).not.toBeNull()
  withoutUncertainties.unmount()
  render(<Card report={{ ...report, userActions: [] }} t={t} disabled={false} onReply={vi.fn()} {...disclosure} />)
  expect(screen.getByText(zh.uncertainties)).not.toBeNull()
  expect(screen.queryByText(zh.userActions)).toBeNull()
  expect(screen.queryByRole('button', { name: '回复' })).toBeNull()
})
it('escapes model text and rejects malformed persisted reports', () => {
  const { container } = render(<Card report={{ ...report, progress: '<img src=x onerror=alert(1)>' }} t={t} disabled={true} onReply={vi.fn()} {...disclosure} />)
  expect(container.querySelector('img')).toBeNull()
  expect(readResult({ type: 'plugin:progress-check/result', ignorable: true, data: { report: {} } })).toBeUndefined()
})

it('keeps only the progress summary when collapsed and can expand while reply is disabled', () => {
  const toggle = vi.fn()
  const { container } = render(<Card report={report} t={t} disabled={true} onReply={vi.fn()} expanded={false} onToggle={toggle} />)
  expect(container.innerHTML).toMatchSnapshot()
  expect(screen.getAllByRole('term')).toHaveLength(1)
  expect(screen.queryByText(zh.uncertainties)).toBeNull()
  expect(screen.queryByRole('button', { name: '回复' })).toBeNull()
  const button = screen.getByRole('button', { name: zh.expandAll })
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(document.getElementById(button.getAttribute('aria-controls')!)).not.toBeNull()
  fireEvent.click(button)
  expect(toggle).toHaveBeenCalledOnce()
})

it('shares disclosure across old and new cards in one session and isolates another session', () => {
  const store = createExpansionStore()
  const first = store.create('first-session')
  const second = store.create('second-session')
  function Cards({ state, count }: { state: typeof first; count: number }) {
    const { expanded } = useSyncExternalStore(state.subscribe, state.getSnapshot)
    return <>{Array.from({ length: count }, (_, index) => <Card key={index} report={report} t={t}
      disabled={false} onReply={vi.fn()} expanded={expanded} onToggle={state.actions.toggle} />)}</>
  }
  const view = render(<><Cards state={first} count={2} /><Cards state={second} count={1} /></>)
  fireEvent.click(screen.getAllByRole('button', { name: zh.collapseAll })[0]!)
  expect(screen.getAllByRole('button', { name: zh.expandAll })).toHaveLength(2)
  expect(screen.getAllByRole('button', { name: zh.collapseAll })).toHaveLength(1)
  view.rerender(<><Cards state={first} count={3} /><Cards state={second} count={1} /></>)
  expect(screen.getAllByRole('button', { name: zh.expandAll })).toHaveLength(3)
  expect(screen.getAllByRole('button', { name: zh.collapseAll })).toHaveLength(1)
  fireEvent.click(screen.getAllByRole('button', { name: zh.expandAll })[1]!)
  expect(screen.queryByRole('button', { name: zh.expandAll })).toBeNull()
  expect(screen.getAllByRole('button', { name: zh.collapseAll })).toHaveLength(4)
})
