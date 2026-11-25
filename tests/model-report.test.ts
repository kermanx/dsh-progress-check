import { describe, expect, it } from 'vitest'
import { modelReportSchema, readResult } from '../src/records.ts'

describe('model progress lines', () => {
  it.each([
    ['正在验证保存修复'],
    ['正在验证保存修复', '下一步检查恢复结果'],
  ])('keeps the progress lines in the durable text report: %j', (...progress) => {
    expect(modelReportSchema.parse({ progress, uncertainties: [], userActions: [] }))
      .toEqual({ progress: progress.join('\n'), uncertainties: [], userActions: [], links: {} })
  })

  it.each([
    { progress: '旧的模型字符串格式' },
    { progress: [] },
    { progress: ['子任务', '当前操作', '下一步'] },
    { progress: ['当前操作', ' '] },
  ])('rejects model progress that cannot fill the card: %j', ({ progress }) => {
    expect(modelReportSchema.safeParse({ progress, uncertainties: [], userActions: [] }).success).toBe(false)
  })

  it('still reads existing records with string progress and no links', () => {
    const report = { progress: '旧卡片的当前进度。', uncertainties: [], userActions: [] }
    expect(readResult({
      type: 'plugin:progress-check/result', ignorable: true,
      data: { version: 1, id: 'legacy-check', sessionId: 'legacy-session', contextSeq: 4, coveredToolCount: 6, report },
    })?.report).toEqual({ ...report, links: {} })
  })

  it('accepts up to 5 key links and rejects invalid URLs or more than 5 links', () => {
    const five = {
      'PR #1': 'https://github.com/a/b/pull/1',
      'Preview': 'http://127.0.0.1:3080',
      'Doc 1': 'https://example.com/1',
      'Doc 2': 'https://example.com/2',
      'Doc 3': 'https://example.com/3',
    }
    expect(modelReportSchema.parse({ progress: ['ok'], uncertainties: [], userActions: [], links: five }).links).toEqual(five)
    expect(modelReportSchema.safeParse({
      progress: ['ok'], uncertainties: [], userActions: [],
      links: { ...five, 'Doc 4': 'https://example.com/4' },
    }).success).toBe(false)
    expect(modelReportSchema.safeParse({
      progress: ['ok'], uncertainties: [], userActions: [],
      links: { 'Bad': 'not-a-url' },
    }).success).toBe(false)
  })
})
