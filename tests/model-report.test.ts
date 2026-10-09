import { describe, expect, it } from 'vitest'
import { modelReportSchema, readResult } from '../src/records.ts'

describe('model progress lines', () => {
  it.each([
    ['正在验证保存修复。', '下一步检查恢复结果。'],
    ['正在修复会话保存。', '正在验证旧格式读取。', '下一步检查恢复结果。'],
  ])('keeps the progress lines in the durable text report: %j', (...progress) => {
    expect(modelReportSchema.parse({ progress, uncertainties: [], userActions: [] }))
      .toEqual({ progress: progress.join('\n'), uncertainties: [], userActions: [] })
  })

  it.each([
    { progress: '旧的模型字符串格式' },
    { progress: [] },
    { progress: ['只有当前操作。'] },
    { progress: ['子任务。', '当前操作。', '下一步。', '多余背景。'] },
    { progress: ['当前操作。', ' '] },
  ])('rejects model progress that cannot fill the card: %j', ({ progress }) => {
    expect(modelReportSchema.safeParse({ progress, uncertainties: [], userActions: [] }).success).toBe(false)
  })

  it('still reads existing records with string progress', () => {
    const report = { progress: '旧卡片的当前进度。', uncertainties: [], userActions: [] }
    expect(readResult({
      type: 'plugin:progress-check/result', ignorable: true,
      data: { version: 1, id: 'legacy-check', sessionId: 'legacy-session', contextSeq: 4, coveredToolCount: 6, report },
    })?.report).toEqual(report)
  })
})
