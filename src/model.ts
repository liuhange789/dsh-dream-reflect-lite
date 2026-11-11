/**
 * 真实模型提炼。
 *
 * 用的是 DSH 宿主真实存在的 LLM 入口：`ctx.llm.stream(GenerateOptions)`
 * （`@deepseek-ai/dsh-llm` 的 `LlmRuntime`）。路由不猜：
 * 取会话日志里最后一条 `request/header` 的 `header.config`，
 * 那就是本次会话正在用的 provider/model；配置里显式给了 provider+model 时优先用配置。
 *
 * 失败一律抛错，由调用方决定降级还是放弃 —— 这里绝不返回伪造的"模型结果"。
 *
 * @module dsh-dream-reflect-lite/model
 */

import { randomUUID } from 'node:crypto'
import type { EventDigest } from './extract.js'
import type { LlmRuntime, Message, SessionEvent } from './types.js'

export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

export interface LlmExtractionInput {
  readonly llm: LlmRuntime
  readonly route: ModelRoute
  readonly digest: EventDigest
  readonly sessionId: string
  readonly maxFacts: number
  readonly maxInputChars: number
  readonly timeoutMs: number
}

/** 助手文本累计上限，防止跑飞时把内存写爆。 */
const MAX_OUTPUT_CHARS = 2_000

/**
 * 从会话日志里读本次会话真实使用的模型路由。
 * `request/header` 是 append 在每次请求前的 header 快照，取最后一条即当前路由。
 */
export function routeFromEvents(events: readonly SessionEvent[]): ModelRoute | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'request/header') continue
    const config = (event.data as { header?: { config?: { provider?: unknown; model?: unknown } } })
      .header?.config
    if (typeof config?.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
    return undefined
  }
  return undefined
}

const SYSTEM_PROMPT = [
  '你是代码协作会话的经验提炼器。',
  '输入是一次会话的结构化摘要（工具调用、文件路径、失败信息、人类诉求）。',
  '请提炼 3 到 5 条「下次可以直接复用」的关键事实，只输出事实本身。',
  '要求：每条一行，以 "- " 开头；中文；单条不超过 60 字；总字数不超过 300 字。',
  '优先顺序：工具链/命令模式 > 关键文件路径 > 配置项 > 踩过的坑。',
  '不要复述过程，不要写建议，不要写"本次会话"这类空话，不要编号，不要 Markdown 标题。',
].join('\n')

/**
 * 用模型提炼事实。任何异常（无路由、超时、模型报错、空输出）都向上抛。
 * @returns 规整后的事实字符串数组（未按 maxFacts 截断，交由调用方处理）
 */
export async function extractWithLlm(input: LlmExtractionInput): Promise<string[]> {
  const digestText = JSON.stringify({
    goal: input.digest.userPrompts.slice(0, 2),
    toolCalls: input.digest.toolCalls.slice(0, 40).map(call => ({
      name: call.name,
      arguments: call.arguments.slice(0, 300),
    })),
    paths: input.digest.paths.slice(0, 20),
    configFiles: input.digest.configFiles,
    failures: input.digest.failures.slice(0, 3),
    lastAssistantText: input.digest.lastAssistantText,
  })
  const bounded = digestText.length > input.maxInputChars
    ? `${digestText.slice(0, input.maxInputChars)}…`
    : digestText

  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `会话摘要：\n${bounded}` }],
    source: { kind: 'plugin', plugin: 'dsh-dream-reflect-lite' },
  } as unknown as Message

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const options = {
    provider: input.route.provider,
    model: input.route.model,
    messages: [message],
    system: SYSTEM_PROMPT,
    maxTokens: 400,
    sessionId: input.sessionId,
    signal: controller.signal,
  } as unknown as Parameters<LlmRuntime['stream']>[0]

  let text = ''
  let finishKind: string | undefined
  try {
    for await (const chunk of input.llm.stream(options)) {
      if (chunk.type === 'text-delta') {
        if (text.length < MAX_OUTPUT_CHARS) text += chunk.text
        continue
      }
      if (chunk.type === 'finish') {
        finishKind = chunk.reason.kind
      }
    }
  } finally {
    clearTimeout(timer)
  }

  if (finishKind !== undefined && finishKind !== 'stop') {
    throw new Error(`模型未正常结束：finish=${finishKind}`)
  }
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
  if (lines.length === 0) throw new Error('模型返回空内容')
  return lines
}
