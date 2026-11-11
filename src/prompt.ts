/**
 * 新会话启动时的轻量上下文注入。
 *
 * 落地方式是 `systemPrompt.section()`：在 **该 agent 的作用域** 注册一个 section，
 * 排序值取 `promptOrder`（默认 500，约定里 100–199 是工具指引，所以 500 已经在末尾）。
 * 用 agent 作用域而不是全局，是为了避免把 A 工作区的经验注入到 B 工作区的会话。
 *
 * 没有卡片时什么都不注册 —— 规格要求"文件不存在就静默跳过"。
 *
 * @module dsh-dream-reflect-lite/prompt
 */

import type { Agent, Context } from './types.js'
import type { CardFile } from './store.js'

/** section 名字唯一，重复注册会抛错（DSH 的 registry 行为）。 */
export const SECTION_NAME = 'dream-reflect:recent-cards'

/**
 * 把最近卡片拼成注入文本。
 * 明确写清来源与优先级，避免模型把历史经验当成当前指令。
 */
export function buildCardsSection(cards: readonly CardFile[], maxChars: number): string {
  if (cards.length === 0) return ''
  const header = [
    '## 工作区反思卡片（dsh-dream-reflect-lite）',
    '以下是该工作区此前会话沉淀的经验卡片，来自 `.dsh/reflections/`；仅作参考，与当前指令冲突时以当前指令为准。',
  ].join('\n')

  const body: string[] = []
  let used = header.length
  for (const card of cards) {
    const chunk = `### ${card.date}\n${card.text.trim()}`
    if (used + chunk.length > maxChars) {
      // 超预算就截断这张卡片，而不是整张丢掉：卡片头部信息通常已经够用。
      const remaining = maxChars - used
      if (remaining > 120) body.push(`${chunk.slice(0, remaining - 1)}…`)
      break
    }
    body.push(chunk)
    used += chunk.length + 1
  }
  if (body.length === 0) return ''
  return `${header}\n\n${body.join('\n\n')}`
}

/**
 * 给一个 agent 注册卡片 section。
 * @returns 注销函数；注册失败时返回 undefined（agent 作用域已销毁等），调用方无需关心。
 */
export function registerCardsSection(
  agent: Agent,
  text: string,
  order: number,
): (() => void) | undefined {
  if (text.length === 0) return undefined
  const scoped: Context | undefined = agent.ctx
  if (scoped === undefined) return undefined
  try {
    return scoped.systemPrompt.section({ name: SECTION_NAME, order, text })
  } catch {
    // 重复注册或作用域已失效：不让注入失败影响会话启动。
    return undefined
  }
}
