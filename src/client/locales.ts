/** Locale-owned labels; model answers retain the conversation's language. */
export const zh = {
  progress: '当前进度', uncertainties: '尚未确认', userActions: '需要你确认',
  reply: '回复', replyTo: '关于「{question}」：', aria: '任务进展',
  generate: '生成进展', generating: '生成中…', generateFailed: '未能生成进展，请重试',
  collapseAll: '折叠本会话的全部进展卡片', expandAll: '展开本会话的全部进展卡片',
}
/** English labels for the same three answers. */
export const en: typeof zh = {
  progress: 'Progress', uncertainties: 'Uncertainties', userActions: 'Needs your input',
  reply: 'Reply', replyTo: 'Regarding “{question}”: ', aria: 'Task progress',
  generate: 'Check progress', generating: 'Generating…', generateFailed: 'Could not generate progress. Try again.',
  collapseAll: 'Collapse all progress cards in this session', expandAll: 'Expand all progress cards in this session',
}
/** Translation keys owned by the progress card. */
export type ProgressKey = keyof typeof zh
