/** Locale-owned labels; model answers retain the conversation's language. */
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

export const zh = {
  progress: '当前进度', uncertainties: '尚未确认', userActions: '需要你确认',
  reply: '回复', replyTo: '关于「{question}」：', aria: '任务进展',
  separator: '；',
  generate: '生成进展', generating: '生成中…', generateFailed: '未能生成进展，请重试',
  timeNow: '<1 分钟前', timeMinutes: '{n} 分钟前', timeHours: '{n} 小时前',
  timeDays: '{n} 天前', timeMonths: '{n} 个月前', timeYears: '{n} 年前',
  stepsAgo: '{n} 步前', stepAgoOne: '{n} 步前',
  // Settings page on the Plugins page.
  settingsAuto: '自动生成',
  settingsLimits: '运行限制',
  settingsNote: '保存后立即生效，无需重启；配置写入当前 profile 的 patch 文件。',
  intervalMs: '生成间隔（毫秒）',
  intervalMsHint: '两次自动生成之间累计的工作时间；会话闲置时暂停计时，60000 表示 1 分钟。',
  intervalSteps: '最少新增步数',
  intervalStepsHint: '两次生成之间至少新增多少个已完成的步骤；与生成间隔同时满足才自动生成，手工生成不受限制。',
  onlyWhenVisible: '仅在被查看时生成',
  onlyWhenVisibleHint: '只在你看着这个会话时自动生成；关闭后即使没有打开该会话也会按间隔生成，可能多消耗 token。',
  includeSubagents: '为子智能体会话生成',
  includeSubagentsHint: '子智能体的会话各自计时、单独生成；默认关闭。',
  refreshOnTurnEnd: '回合结束时刷新',
  refreshOnTurnEndHint: '回合结束且有非只读工具调用时自动刷新卡片；默认关闭。',
  maxConcurrent: '并发生成上限',
  maxConcurrentHint: '同一 DSH 进程内同时进行的生成数，最小 1。',
  timeoutMs: '生成超时（毫秒）',
  timeoutMsHint: '一次生成从排队到结束（含等待与重试）的最长时间，超时按失败处理。',
  maxResponseBytes: '响应大小上限（字节）',
  maxResponseBytesHint: '单次生成接受的响应大小上限，超出按失败处理；262144 表示 256 KiB。',
  maxParseRetries: '格式重试次数',
  maxParseRetriesHint: '仅在回合结束自动刷新遇到格式不合格时重试（0–3）；加上首次请求最多共 4 次尝试，运行中与手工生成不重试。',
  overridden: '已修改',
  reset: '恢复默认',
  invalidNumber: '请填写有效的整数。',
  settingsUnavailable: '当前部署未提供可编辑的插件配置。',
  settingsReadOnly: '当前部署的配置为只读。',
  settingsSaveFailed: '当前部署没有接受这些值，已保留供你修改。',
  save: '保存',
  saving: '保存中…',
}
/** English labels for the same surface. */
export const en: typeof zh = {
  progress: 'Progress', uncertainties: 'Uncertainties', userActions: 'Needs your input',
  reply: 'Reply', replyTo: 'Regarding “{question}”: ', aria: 'Task progress',
  separator: '; ',
  generate: 'Check progress', generating: 'Generating…', generateFailed: 'Could not generate progress. Try again.',
  timeNow: '<1min ago', timeMinutes: '{n}min ago', timeHours: '{n}h ago',
  timeDays: '{n}d ago', timeMonths: '{n}mo ago', timeYears: '{n}y ago',
  stepsAgo: '{n} steps ago', stepAgoOne: '1 step ago',
  settingsAuto: 'Automatic reports',
  settingsLimits: 'Limits',
  settingsNote: 'Changes apply immediately without a restart; they are saved to the current profile’s patch file.',
  intervalMs: 'Report interval (ms)',
  intervalMsHint: 'Accumulated working time between automatic reports; the timer pauses while the session is idle. 60000 is one minute.',
  intervalSteps: 'Minimum new steps',
  intervalStepsHint: 'Completed steps added between reports before another one is generated; both this and the interval must be met. Manual reports ignore it.',
  onlyWhenVisible: 'Only while viewing the session',
  onlyWhenVisibleHint: 'Generate automatic reports only while you are watching the session. When off, reports are generated on the interval even when the session is not open, which may use more tokens.',
  includeSubagents: 'Report subagent sessions',
  includeSubagentsHint: 'Each subagent session gets its own timer and reports. Off by default.',
  refreshOnTurnEnd: 'Refresh on turn end',
  refreshOnTurnEndHint: 'Automatically refresh the card when a turn ends after non-read-only tool calls. Off by default.',
  maxConcurrent: 'Concurrent report limit',
  maxConcurrentHint: 'Reports generated at once in one DSH process. Minimum 1.',
  timeoutMs: 'Report timeout (ms)',
  timeoutMsHint: 'Longest a report may take from queueing to completion, including retries. A timeout counts as a failure.',
  maxResponseBytes: 'Response size limit (bytes)',
  maxResponseBytesHint: 'Largest accepted report response; a larger response counts as a failure. 262144 is 256 KiB.',
  maxParseRetries: 'Format retries',
  maxParseRetriesHint: 'Retries when a turn-end report is not valid (0–3); up to four attempts including the first request. Mid-turn and manual checks never retry.',
  overridden: 'Modified',
  reset: 'Restore default',
  invalidNumber: 'Enter a valid whole number.',
  settingsUnavailable: 'This deployment has no editable plugin configuration.',
  settingsReadOnly: 'This deployment stores configuration read-only.',
  settingsSaveFailed: 'This deployment did not accept these values; they were kept for you to correct.',
  save: 'Save',
  saving: 'Saving…',
}
/** Translation keys owned by the progress card and its settings page. */
export type ProgressKey = keyof typeof zh

/**
 * Read the shared settings form's chrome from the plugin dictionary.
 * @param t - current locale reader.
 * @returns localized form labels.
 */
export function formLabels(t: (key: ProgressKey) => string): SettingsFormLabels {
  return {
    unavailable: t('settingsUnavailable'), readOnly: t('settingsReadOnly'),
    saveFailed: t('settingsSaveFailed'), save: t('save'), saving: t('saving'),
  }
}
