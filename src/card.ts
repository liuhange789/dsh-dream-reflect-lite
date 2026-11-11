/**
 * 卡片正文的生成与裁剪。
 *
 * 卡片是给人看也给人改的普通 Markdown，所以这里只有一条硬规则：
 * 事实条目渲染出来的正文不超过 `maxCardChars`（默认 300 字）。
 * 超了从最长的一条开始截断，而不是整条丢弃 —— 丢一条会丢掉信息，
 * 截断只是变短，用户还能自己补。
 *
 * @module dsh-dream-reflect-lite/card
 */

/** 事实来源：模型提炼 / 启发式提取 / 用户手动触发。 */
export type CardSource = 'llm' | 'heuristic' | 'manual'

export interface CardDraft {
  readonly facts: readonly string[]
  readonly source: CardSource
  /** 写入时间，用于卡片标题里的时间戳。 */
  readonly at: Date
  /** 附注信息，写到卡片末尾的 HTML 注释里（Markdown 渲染不可见，但纯文本可读）。 */
  readonly meta?: {
    readonly provider?: string
    readonly model?: string
    readonly toolCalls?: number
    readonly sessionId?: string
  }
}

/** 单条事实自身的上限，防止一条事实吃掉整张卡片。 */
const MAX_FACT_CHARS = 160

/**
 * 规整模型/启发式产出的事实列表。
 * 去掉列表符号、空行、重复项，超长单条截断，最后按 `maxFacts` 截取。
 */
export function normalizeFacts(raw: readonly string[], maxFacts: number): string[] {
  const seen = new Set<string>()
  const facts: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const cleaned = entry
      .replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned.length === 0) continue
    const bounded = cleaned.length > MAX_FACT_CHARS
      ? `${cleaned.slice(0, MAX_FACT_CHARS - 1)}…`
      : cleaned
    const key = bounded.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    facts.push(bounded)
    if (facts.length >= maxFacts) break
  }
  return facts
}

/** 两位补零。 */
function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * 把草稿渲染成一张卡片。
 * 结构固定为「标题行 + 事实列表 + 可选注释」，这样追加到同一天的 md 文件里也整齐。
 */
export function renderCard(draft: CardDraft, options: { maxCardChars: number }): string {
  const budget = Math.max(0, options.maxCardChars)
  const lines: string[] = []
  let used = 0

  for (const fact of draft.facts) {
    // 一条事实渲染成 "- xxx\n"，占用长度包含前缀和换行。
    const prefix = '- '
    const remaining = budget - used - prefix.length - 1
    if (remaining <= 4) break
    const text = fact.length > remaining ? `${fact.slice(0, Math.max(0, remaining - 1))}…` : fact
    lines.push(`${prefix}${text}`)
    used += prefix.length + text.length + 1
  }

  const clock = `${pad(draft.at.getHours())}:${pad(draft.at.getMinutes())}`
  const heading = `## ${clock} · ${draft.source} · ${lines.length} 条`

  const metaParts: string[] = []
  if (draft.meta?.provider !== undefined && draft.meta.model !== undefined) {
    metaParts.push(`model=${draft.meta.provider}/${draft.meta.model}`)
  }
  if (draft.meta?.toolCalls !== undefined) metaParts.push(`toolCalls=${draft.meta.toolCalls}`)
  if (draft.meta?.sessionId !== undefined) metaParts.push(`session=${draft.meta.sessionId}`)
  const comment = metaParts.length > 0
    ? `\n<!-- dsh-dream-reflect-lite ${metaParts.join(' ')} -->`
    : ''

  return `${heading}\n${lines.join('\n')}${comment}\n`
}
