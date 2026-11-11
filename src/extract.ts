/**
 * 启发式提取：完全不依赖模型的降级路径。
 *
 * 只使用会话日志里**客观存在**的结构化信息 —— 工具调用序列、参数里出现的文件路径、
 * 失败的工具结果、被改动的配置文件、最后一条人类提问。
 * 不编造、不猜测、不"总结语义"，所以它给出的每条事实都能被用户在会话里对上号。
 *
 * 这也是 `mode: 'auto'` 在模型不可用（没有 llm 服务、没有可用路由、调用失败）时的兜底。
 *
 * @module dsh-dream-reflect-lite/extract
 */

import type { SessionEvent } from './types.js'

/** 一次提取用到的会话摘要。字段都是"取到的原始材料"，不含结论。 */
export interface EventDigest {
  /** 人类提问（插件注入的上下文不算），按时间先后。 */
  readonly userPrompts: string[]
  /** 工具调用序列。 */
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly arguments: string }>
  /** 失败工具结果的文本片段。 */
  readonly failures: string[]
  /** 参数/结果里出现过的文件路径，去重后按出现顺序。 */
  readonly paths: string[]
  /** 被改动过的配置文件路径。 */
  readonly configFiles: string[]
  /** 最后一段助手文本，用于给卡片一个"产出"落点。 */
  readonly lastAssistantText: string
}

const MAX_TEXT_BLOCK_CHARS = 400
const MAX_PATH_CANDIDATES = 40

/** 从内容块数组里抽出纯文本，按块顺序拼接。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n').trim()
}

const CONFIG_FILE_PATTERN =
  /^(package\.json|package-lock\.json|tsconfig[^\\/]*\.json|pnpm-workspace\.yaml|[^\\/]*\.ya?ml|\.npmrc|\.gitignore|\.env[^\\/]*)$/i

/** 参数文本里出现的、看起来像文件路径的字符串。 */
const QUOTED_PATH_PATTERN = /"((?:[A-Za-z]:)?[^"\n\\/]{0,120}[\\/][^"\n]*\.[A-Za-z0-9_]{1,8})"/g

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

function collectPathCandidates(raw: string): string[] {
  const found: string[] = []
  QUOTED_PATH_PATTERN.lastIndex = 0
  let match = QUOTED_PATH_PATTERN.exec(raw)
  while (match !== null && found.length < MAX_PATH_CANDIDATES) {
    const candidate = match[1]
    if (candidate !== undefined && candidate.length >= 3) found.push(candidate)
    match = QUOTED_PATH_PATTERN.exec(raw)
  }
  return found
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * 把一段会话事件压成摘要。
 * `maxEvents` 限制扫描窗口，长会话不会因为提取而变慢。
 */
export function digestEvents(events: readonly SessionEvent[], maxEvents: number): EventDigest {
  const window = maxEvents > 0 && events.length > maxEvents
    ? events.slice(events.length - maxEvents)
    : events

  const userPrompts: string[] = []
  const toolCalls: Array<{ name: string; arguments: string }> = []
  const failures: string[] = []
  const paths: string[] = []
  const configFiles: string[] = []
  const seenPaths = new Set<string>()
  const seenConfigs = new Set<string>()
  let lastAssistantText = ''

  const rememberPath = (candidate: string): void => {
    if (seenPaths.has(candidate)) return
    seenPaths.add(candidate)
    paths.push(candidate)
    const name = basename(candidate)
    if (CONFIG_FILE_PATTERN.test(name) && !seenConfigs.has(name)) {
      seenConfigs.add(name)
      configFiles.push(name)
    }
  }

  for (const event of window) {
    switch (event.type) {
      case 'user/message': {
        const source = (event.data as { source?: { kind?: string } }).source
        // 插件注入的上下文（AGENTS.md、skill、cron 通知…）不是人类诉求，跳过。
        if (source?.kind === 'plugin') break
        const text = textOf((event.data as { content?: unknown }).content)
        if (text.length > 0) userPrompts.push(truncate(text, MAX_TEXT_BLOCK_CHARS))
        break
      }
      case 'assistant/message': {
        const text = textOf((event.data as { message?: { content?: unknown } }).message?.content)
        if (text.length > 0) lastAssistantText = truncate(text, MAX_TEXT_BLOCK_CHARS)
        break
      }
      case 'tool/call': {
        const data = event.data as { name?: unknown; arguments?: unknown }
        const name = typeof data.name === 'string' ? data.name : 'unknown'
        const rawArguments = typeof data.arguments === 'string' ? data.arguments : ''
        toolCalls.push({ name, arguments: rawArguments })
        for (const candidate of collectPathCandidates(rawArguments)) rememberPath(candidate)
        break
      }
      case 'tool/result': {
        const message = (event.data as { message?: { content?: unknown } }).message
        const first = Array.isArray(message?.content) ? message?.content[0] : undefined
        if (typeof first !== 'object' || first === null) break
        const block = first as { isError?: unknown; content?: unknown }
        if (block.isError === true) {
          const text = truncate(textOf(block.content), 120)
          if (text.length > 0) failures.push(text)
        }
        break
      }
      default:
        break
    }
  }

  return { userPrompts, toolCalls, failures, paths, configFiles, lastAssistantText }
}

/** 把数组压成 `a×3、b×2` 形式，按次数降序。 */
function summarizeToolChain(calls: ReadonlyArray<{ name: string }>, limit: number): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, count]) => `${name}×${count}`)
    .join('、')
}

/**
 * 依据摘要生成 3–5 条事实。
 * 顺序按"复用价值"排：先目标与工具链，再关键路径与配置，最后踩坑与产出。
 */
export function heuristicFacts(digest: EventDigest, options: { maxFacts: number }): string[] {
  const facts: string[] = []

  const goal = digest.userPrompts[0]
  if (goal !== undefined) facts.push(`目标：${truncate(goal, 70)}`)

  if (digest.toolCalls.length > 0) {
    const chain = summarizeToolChain(digest.toolCalls, 4)
    facts.push(`工具链：${chain}（共 ${digest.toolCalls.length} 次调用）`)
  }

  if (digest.paths.length > 0) {
    const top = digest.paths.slice(0, 3).map(path => truncate(path, 48))
    facts.push(`关键路径：${top.join('、')}`)
  }

  if (digest.configFiles.length > 0) {
    facts.push(`配置：改动涉及 ${digest.configFiles.slice(0, 4).join('、')}`)
  }

  for (const failure of digest.failures.slice(0, 2)) {
    facts.push(`踩坑：${failure}`)
  }

  if (digest.lastAssistantText.length > 0 && facts.length < options.maxFacts) {
    facts.push(`产出：${truncate(digest.lastAssistantText, 70)}`)
  }

  return facts.slice(0, options.maxFacts)
}
