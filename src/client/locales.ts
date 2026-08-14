/** Browser copy for Codex-owned trajectory blocks. */

/** Dictionary namespace owned by the Codex provider browser plugin. */
export const NS = 'codex-app-server'

/** Simplified Chinese dictionary and key-set authority. */
export const zh = {
  'action.category.lifecycle': 'Codex 生命周期',
  'action.category.context': 'Codex 上下文',
  'action.category.action': 'Codex 原生动作',
  'action.category.diagnostic': 'Codex 诊断',
  'action.phase.requested': '已请求',
  'action.phase.started': '进行中',
  'action.phase.updated': '已更新',
  'action.phase.completed': '已完成',
  'action.phase.failed': '失败',
  'action.phase.declined': '已拒绝',
  'action.type.threadStart': '启动原生会话',
  'action.type.contextInjected': '注入模型上下文',
  'action.type.commandExecution': '执行原生命令',
  'action.type.commandOutput': '更新命令输出',
  'action.type.customToolCall': '发起 Code Mode 调用',
  'action.type.customToolOutput': '接收 Code Mode 结果',
  'action.type.planUpdated': '更新原生计划',
  'action.summary.threadStart': '分层共治：Codex 仍提供原生 prompt 与工具；发现 {count} 个指令源。',
  'action.summary.context': '这是 Codex 额外加入模型请求的 {kind} 上下文，不是 Harness 编写的消息。',
  'action.summary.command': '原生命令：{command}',
  'action.summary.status': '协议状态：{status}',
  'action.protocolEvent': '协议事件',
  'action.id': '动作 ID',
  'action.details': '完整 Codex 协议记录',
  'json.truncated': '…已截断，共 {total} 字符',
  'message.unknownBlock': '未知内容块',
  'message.stopped': '已停止',
  'copy': '复制',
  'copied': '已复制',
  'reasoning.title': 'Think',
  'reasoning.running': '思考中',
  'image.label': '图片',
  'image.openOriginal': '查看原图',
  'image.openOriginalLabel': '查看原图：{label}',
  'image.loading': '正在加载图片',
  'image.loadFailed': '图片加载失败，点击重试',
  'image.preview': '原图预览',
  'image.closePreview': '关闭原图预览',
} satisfies Record<string, string>

/** Browser dictionary key union. */
export type CodexUiKey = keyof typeof zh

/** English dictionary, complete against the Chinese key set. */
export const en = {
  'action.category.lifecycle': 'Codex lifecycle',
  'action.category.context': 'Codex context',
  'action.category.action': 'Codex-native action',
  'action.category.diagnostic': 'Codex diagnostic',
  'action.phase.requested': 'Requested',
  'action.phase.started': 'Running',
  'action.phase.updated': 'Updated',
  'action.phase.completed': 'Completed',
  'action.phase.failed': 'Failed',
  'action.phase.declined': 'Declined',
  'action.type.threadStart': 'Start native session',
  'action.type.contextInjected': 'Inject model context',
  'action.type.commandExecution': 'Run native command',
  'action.type.commandOutput': 'Update command output',
  'action.type.customToolCall': 'Request Code Mode call',
  'action.type.customToolOutput': 'Receive Code Mode result',
  'action.type.planUpdated': 'Update native plan',
  'action.summary.threadStart': 'Layered control: Codex still supplies native prompts and tools; {count} instruction source(s) were discovered.',
  'action.summary.context': 'Codex added this {kind} context to the model request; it is not a Harness-authored message.',
  'action.summary.command': 'Native command: {command}',
  'action.summary.status': 'Protocol status: {status}',
  'action.protocolEvent': 'Protocol event',
  'action.id': 'Action ID',
  'action.details': 'Complete Codex protocol record',
  'json.truncated': '…truncated, {total} characters total',
  'message.unknownBlock': 'Unknown content block',
  'message.stopped': 'Stopped',
  'copy': 'Copy',
  'copied': 'Copied',
  'reasoning.title': 'Think',
  'reasoning.running': 'Thinking',
  'image.label': 'Image',
  'image.openOriginal': 'View original image',
  'image.openOriginalLabel': 'View original image: {label}',
  'image.loading': 'Loading image',
  'image.loadFailed': 'Image failed to load; click to retry',
  'image.preview': 'Original image preview',
  'image.closePreview': 'Close original image preview',
} satisfies Record<CodexUiKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Codex-owned trajectory presentation. */
    'codex-app-server': CodexUiKey
  }
}
