// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GenerateAction } from '../src/client/GenerateAction.tsx'
import { zh } from '../src/client/locales.ts'
import type { ProgressKey } from '../src/client/locales.ts'

const t = (key: ProgressKey) => zh[key]
afterEach(cleanup)

it('shows generation in place and ignores repeated clicks until completion', async () => {
  const pending = Promise.withResolvers<boolean>()
  const generate = vi.fn(() => pending.promise)
  const { container } = render(<GenerateAction t={t} generate={generate} onFailure={vi.fn()} />)
  expect(container.innerHTML).toMatchSnapshot()
  fireEvent.click(screen.getByRole('button', { name: '生成进展' }))
  const button = screen.getByRole('button', { name: '生成中…' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  expect(generate).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve(true); await pending.promise })
  expect(screen.getByRole('button', { name: '生成进展' }).hasAttribute('disabled')).toBe(false)
})

it('reports a failed request through the shell notice', async () => {
  const failure = vi.fn()
  render(<GenerateAction t={t} generate={async () => false} onFailure={failure} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成进展' })) })
  expect(failure).toHaveBeenCalledOnce()
})

it('aborts its caller on unmount without a failure notice', async () => {
  const pending = Promise.withResolvers<boolean>()
  const failure = vi.fn()
  let signal: AbortSignal | undefined
  const view = render(<GenerateAction t={t} generate={async value => { signal = value; return pending.promise }} onFailure={failure} />)
  fireEvent.click(screen.getByRole('button', { name: '生成进展' }))
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => { pending.resolve(false); await pending.promise })
  expect(failure).not.toHaveBeenCalled()
})
