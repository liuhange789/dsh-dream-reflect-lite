/**
 * 两个工具。
 *
 * 工具契约按 DSH 的真实要求写：`output.schema` 必须是对象、`output.render` 必须是函数、
 * `execute` 必须返回与 schema 一致的对象。少任何一项，`ctx.tools.register()` 会当场抛
 * `tool "x" must declare output { schema, render, presentationMeta? }`。
 *
 * schema 只使用 DSH 支持的 JSON Schema 子集
 * （type/oneOf/properties/required/additionalProperties/items/enum/const + title/description），
 * 所以这里没有 minimum/maximum 之类的关键字 —— 写了会被 `assertSupportedJsonSchema` 拒掉。
 *
 * @module dsh-dream-reflect-lite/tools
 */

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from './types.js'
import { readRecentCards, resolveWorkspace } from './store.js'
import type { CardFile } from './store.js'

/** 一次手动/自动沉淀的结果，给工具层和日志层共用。 */
export interface ReflectOutcome {
  readonly written: boolean
  readonly path: string
  readonly source: 'llm' | 'heuristic' | 'manual'
  readonly facts: readonly string[]
  /** 没写成功时的原因，成功时为空串。 */
  readonly note: string
}

/** 由 index.ts 注入的沉淀执行器（自动与手动共用同一条链路）。 */
export type ReflectionRunner = (
  agent: Agent | undefined,
  options: { readonly force: boolean },
) => Promise<ReflectOutcome>

export interface ToolDeps {
  readonly relativeDir: string
  readonly recentCards: number
  readonly runReflection: ReflectionRunner
}

/** 从卡片文件正文里数出条目数，用于回执里给个直观的量。 */
function countFacts(card: CardFile): number {
  return card.text.split(/\r?\n/).filter(line => line.trim().startsWith('- ')).length
}

function renderText(lines: readonly string[]): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * `recall_reflections`：读当前工作区最近的反思卡片。
 * 这是"用户可编辑可删除"的可见出口 —— 模型想回看历史经验时直接调它。
 */
export function createRecallTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'recall_reflections',
    description:
      '读取当前工作区最近的反思卡片（.dsh/reflections/*.md）。用于回看此前会话沉淀的可复用经验；可选 limit 控制返回几张，query 做大小写不敏感的包含匹配。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: `返回最近几张卡片，默认 ${deps.recentCards}。`,
        },
        query: {
          type: 'string',
          description: '可选关键词；命中的卡片才返回（匹配卡片正文）。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: '卡片所属工作区绝对路径。' },
          total: { type: 'integer', description: '本次返回的卡片数量。' },
          cards: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                date: { type: 'string', description: '卡片文件日期戳 YYYY-MM-DD。' },
                path: { type: 'string', description: '卡片文件绝对路径。' },
                facts: { type: 'integer', description: '卡片里的条目数。' },
                text: { type: 'string', description: '卡片全文。' },
              },
              required: ['date', 'path', 'facts', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: ['workspace', 'total', 'cards'],
        additionalProperties: false,
      },
      render(_args, value) {
        const data = value as {
          workspace: string
          total: number
          cards: Array<{ date: string; path: string; facts: number; text: string }>
        }
        if (data.total === 0) {
          return renderText([`工作区 ${data.workspace} 暂无反思卡片（.dsh/reflections 下没有 *.md）。`])
        }
        const lines = [`工作区 ${data.workspace} 共返回 ${data.total} 张卡片：`]
        for (const card of data.cards) {
          lines.push('', `--- ${card.date}（${card.facts} 条）${card.path}`, card.text.trim())
        }
        return renderText(lines)
      },
    },
    async execute(args, exec: ToolRunContext) {
      const input = (typeof args === 'object' && args !== null ? args : {}) as {
        limit?: unknown
        query?: unknown
      }
      const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0
        ? Math.min(input.limit, 20)
        : deps.recentCards
      const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''

      const workspace = resolveWorkspace(exec.agent?.session.header.cwd)
      // 多读一点再过滤，避免 query 把目标卡片挤出去。
      const candidates = readRecentCards(workspace, deps.relativeDir, query.length > 0 ? 20 : limit)
      const filtered = query.length > 0
        ? candidates.filter(card => card.text.toLowerCase().includes(query))
        : candidates
      const cards = filtered.slice(0, limit).map(card => ({
        date: card.date,
        path: card.path,
        facts: countFacts(card),
        text: card.text.trim(),
      }))

      return { workspace, total: cards.length, cards }
    },
  }
}

/**
 * `reflect_now`：立即为当前会话沉淀一张卡片。
 * 与自动触发走同一条链路，只是跳过"最少工具调用次数"的门槛，方便用户主动收口经验。
 */
export function createReflectNowTool(deps: ToolDeps): ToolDefinition {
  return {
    name: 'reflect_now',
    description:
      '立即把当前会话沉淀成一张反思卡片，写入 {工作区}/.dsh/reflections/{当天日期}.md。用于会话中途想固化经验时；不用它也会在轮次结束时自动沉淀。',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: '可选备注，追加到本次提取的说明里（不会写进卡片正文）。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          written: { type: 'boolean', description: '是否真的写入了卡片文件。' },
          path: { type: 'string', description: '写入的卡片文件路径；未写入时为空串。' },
          source: { type: 'string', description: '事实来源：llm | heuristic | manual。' },
          facts: {
            type: 'array',
            items: { type: 'string' },
            description: '写入卡片的事实条目。',
          },
          note: { type: 'string', description: '未写入时的原因说明。' },
        },
        required: ['written', 'path', 'source', 'facts', 'note'],
        additionalProperties: false,
      },
      render(_args, value) {
        const data = value as {
          written: boolean
          path: string
          source: string
          facts: string[]
          note: string
        }
        if (!data.written) {
          return renderText([`未写入卡片：${data.note}`])
        }
        return renderText([
          `已写入 ${data.path}（来源 ${data.source}，${data.facts.length} 条）`,
          ...data.facts.map(fact => `- ${fact}`),
        ])
      },
    },
    async execute(_args, exec: ToolRunContext) {
      const outcome = await deps.runReflection(exec.agent, { force: true })
      return {
        written: outcome.written,
        path: outcome.path,
        source: outcome.source,
        facts: [...outcome.facts],
        note: outcome.note,
      }
    },
  }
}
