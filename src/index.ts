/**
 * dsh-dream-reflect-lite —— 轻量级跨会话反思卡片。
 *
 * 两半职责，各自独立、互不依赖：
 *
 * 1. **沉淀（会话结束时）**：`agent/status` 回到 `idle` 即一轮工作结束，
 *    取这一轮新增的会话事件 → 提炼 3–5 条事实 → 追加到 `{workspace}/.dsh/reflections/{date}.md`。
 *    DSH 没有 session-end 事件，`idle` 是"这一轮真的做完了"的唯一可靠信号；
 *    用 `minToolCalls` 门槛保证闲聊不写卡片。
 *
 * 2. **回放（新会话启动时）**：`agent/session-start` 读最近 3 张卡片，
 *    以 `systemPrompt.section` 注入到该 agent 作用域的提示词末尾；没有卡片就什么都不做。
 *
 * 两条路径共用同一个 `runReflection()`，所以自动沉淀和 `reflect_now` 工具的行为完全一致。
 * 全部失败都只记日志、不抛给宿主：上下文插件挂掉不能拖垮会话。
 *
 * @module dsh-dream-reflect-lite
 */

import type { Agent, Context, SessionEvent } from './types.js'
import { resolveConfig } from './config.js'
import type { ReflectConfig } from './config.js'
import { digestEvents, heuristicFacts } from './extract.js'
import { extractWithLlm, routeFromEvents } from './model.js'
import { normalizeFacts, renderCard } from './card.js'
import type { CardSource } from './card.js'
import { appendCard, readRecentCards, resolveWorkspace } from './store.js'
import { buildCardsSection, registerCardsSection } from './prompt.js'
import { createRecallTool, createReflectNowTool } from './tools.js'
import type { ReflectOutcome } from './tools.js'

export const name = 'dsh-dream-reflect-lite'

/** 只依赖真实存在的两个服务；`llm` 是可选的，用 `ctx.get('llm')` 取，不在 inject 里强绑。 */
export const inject = ['tools', 'systemPrompt'] as const

/** 单次提取最多回看的会话事件数，避免超长会话把提取拖慢。 */
const MAX_EVENT_WINDOW = 200

interface SessionState {
  /** 已经沉淀到哪一条事件（seq）；0 表示还没写过卡片。 */
  lastSeq: number
  /** 正在沉淀中，防止 idle 多次触发并发写同一个文件。 */
  inFlight: boolean
}

function lastSeqOf(events: readonly SessionEvent[]): number {
  const last = events[events.length - 1]
  return last === undefined ? 0 : last.seq
}

/** 取 `seq > sinceSeq` 的最近 `limit` 条事件。 */
function recentEvents(
  events: readonly SessionEvent[],
  sinceSeq: number,
  limit: number,
): SessionEvent[] {
  const fresh = events.filter(event => event.seq > sinceSeq)
  return fresh.length > limit ? fresh.slice(fresh.length - limit) : fresh
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 插件入口。
 * @param ctx 宿主上下文（`tools` / `systemPrompt` 由 inject 保证存在）
 * @param rawConfig cordis loader 传入的原始配置，这里自行校验
 * @returns 卸载函数
 */
export function apply(ctx: Context, rawConfig?: unknown): () => void {
  const { config, warnings } = resolveConfig(rawConfig)
  const logger = ctx.logger(name)

  for (const warning of warnings) logger.warn(`[config] ${warning}`)

  if (!config.enabled) {
    logger.info('插件已按配置禁用（enabled=false），不注册工具、不注入上下文、不自动沉淀')
    return () => {}
  }

  logger.info(
    `已加载：mode=${config.mode} dir=${config.relativeDir} maxFacts=${config.maxFacts} `
    + `maxCardChars=${config.maxCardChars} minToolCalls=${config.minToolCalls} recentCards=${config.recentCards}`,
  )

  const sessions = new Map<string, SessionState>()
  const disposers: Array<() => boolean | void> = []

  const stateOf = (agent: Agent): SessionState => {
    const key = String(agent.session.id)
    let state = sessions.get(key)
    if (state === undefined) {
      state = { lastSeq: 0, inFlight: false }
      sessions.set(key, state)
    }
    return state
  }

  /**
   * 用模型或启发式提炼事实。
   * 返回 `undefined` 表示"这次没有可用材料/按配置不该写"，调用方据此不写卡片。
   */
  const extractFacts = async (
    digest: ReturnType<typeof digestEvents>,
    sessionEvents: readonly SessionEvent[],
    agent: Agent,
  ): Promise<{ facts: string[]; source: CardSource } | undefined> => {
    if (config.mode !== 'heuristic') {
      const llm = ctx.get('llm')
      const route = config.provider !== undefined && config.model !== undefined
        ? { provider: config.provider, model: config.model }
        : routeFromEvents(sessionEvents)

      if (llm === undefined) {
        logger.warn('宿主没有 llm 服务，本轮无法用模型提炼')
      } else if (route === undefined) {
        logger.warn('会话日志里没有可用的 request/header 路由，本轮无法用模型提炼')
      } else {
        try {
          const raw = await extractWithLlm({
            llm,
            route,
            digest,
            sessionId: String(agent.session.id),
            maxFacts: config.maxFacts,
            maxInputChars: config.maxInputChars,
            timeoutMs: config.timeoutMs,
          })
          const facts = normalizeFacts(raw, config.maxFacts)
          if (facts.length >= 3) return { facts, source: 'llm' }
          logger.warn(`模型只给出 ${facts.length} 条事实（要求 3–5 条），判定为不可用`)
        } catch (error) {
          logger.warn(`模型提炼失败：${errorMessage(error)}`)
        }
      }
      if (config.mode === 'llm') return undefined
      logger.info('回退到启发式提取')
    }

    const facts = normalizeFacts(heuristicFacts(digest, { maxFacts: config.maxFacts }), config.maxFacts)
    if (facts.length === 0) return undefined
    return { facts, source: 'heuristic' }
  }

  /**
   * 沉淀一次。自动触发与 `reflect_now` 共用。
   * @param force true 时跳过 `minToolCalls` 门槛（用户显式要求就该写）
   */
  const runReflection = async (
    agent: Agent | undefined,
    options: { force: boolean },
  ): Promise<ReflectOutcome> => {
    const skip = (note: string): ReflectOutcome => ({
      written: false,
      path: '',
      source: 'heuristic',
      facts: [],
      note,
    })

    if (agent === undefined) return skip('当前调用没有关联 agent，无法定位会话')

    const state = stateOf(agent)
    if (state.inFlight) return skip('上一次沉淀仍在进行中')

    const session = agent.session
    const allEvents = session.events
    const fresh = recentEvents(allEvents, state.lastSeq, MAX_EVENT_WINDOW)
    const toolCalls = fresh.filter(event => event.type === 'tool/call').length

    if (!options.force && toolCalls < config.minToolCalls) {
      return skip(`本轮只有 ${toolCalls} 次工具调用，低于门槛 ${config.minToolCalls}，累计到下一轮再试`)
    }
    if (config.skipSubagentSessions && session.header.origin === 'subagent') {
      return skip('子代理会话按配置跳过')
    }

    const digest = digestEvents(fresh, MAX_EVENT_WINDOW)
    if (digest.toolCalls.length === 0 && digest.userPrompts.length === 0) {
      return skip('窗口内没有可提炼的材料')
    }

    state.inFlight = true
    try {
      const extracted = await extractFacts(digest, allEvents, agent)
      if (extracted === undefined) return skip('没有提炼出可用事实')

      const at = new Date()
      const card = renderCard(
        {
          facts: extracted.facts,
          source: extracted.source,
          at,
          meta: {
            provider: config.provider ?? routeFromEvents(allEvents)?.provider,
            model: config.model ?? routeFromEvents(allEvents)?.model,
            toolCalls,
            sessionId: String(session.id),
          },
        },
        { maxCardChars: config.maxCardChars },
      )

      const workspace = resolveWorkspace(session.header.cwd)
      const path = await appendCard(workspace, config.relativeDir, card, at)
      state.lastSeq = lastSeqOf(allEvents)
      logger.info(`已沉淀卡片（${extracted.source}，${extracted.facts.length} 条，${toolCalls} 次工具调用）：${path}`)
      return { written: true, path, source: extracted.source, facts: extracted.facts, note: '' }
    } catch (error) {
      logger.warn(`沉淀失败：${errorMessage(error)}`)
      return skip(`沉淀失败：${errorMessage(error)}`)
    } finally {
      state.inFlight = false
    }
  }

  // ── 一半职责：新会话启动时注入最近卡片 ────────────────────────────────────
  disposers.push(ctx.on('agent/session-start', ({ agent }) => {
    if (!config.loadOnStart) return
    try {
      const workspace = resolveWorkspace(agent.session.header.cwd)
      const cards = readRecentCards(workspace, config.relativeDir, config.recentCards)
      if (cards.length === 0) {
        logger.debug(`工作区 ${workspace} 没有反思卡片，跳过注入`)
        return
      }
      const text = buildCardsSection(cards, config.promptMaxChars)
      const dispose = registerCardsSection(agent, text, config.promptOrder)
      if (dispose === undefined) {
        logger.warn('反思卡片 section 注册失败（作用域已失效或重复注册）')
        return
      }
      disposers.push(dispose)
      logger.info(`已注入 ${cards.length} 张反思卡片（${cards.map(card => card.date).join(', ')}）`)
    } catch (error) {
      logger.warn(`读取反思卡片失败：${errorMessage(error)}`)
    }
  }))

  // ── 另一半职责：一轮结束（agent 回到 idle）时沉淀 ─────────────────────────
  disposers.push(ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    // 不 await：idle 之后宿主可能立刻进入下一轮，沉淀是后台工作。
    void runReflection(agent, { force: false }).then((outcome) => {
      if (!outcome.written) logger.debug(`本轮未写卡片：${outcome.note}`)
    })
  }))

  // ── 工具：读卡片 / 立即沉淀 ──────────────────────────────────────────────
  const toolDeps = {
    relativeDir: config.relativeDir,
    recentCards: config.recentCards,
    runReflection,
  }
  disposers.push(ctx.tools.register(createRecallTool(toolDeps)))
  disposers.push(ctx.tools.register(createReflectNowTool(toolDeps)))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 卸载阶段单项失败不应阻断其余清理。
      }
    }
    sessions.clear()
    logger.info('已卸载')
  }
}

/** DSH loader 同时接受 `apply` 与 `setup` 两种导出名，这里保持兼容。 */
export const setup = apply

export type { ReflectConfig } from './config.js'
export type { ReflectOutcome } from './tools.js'
