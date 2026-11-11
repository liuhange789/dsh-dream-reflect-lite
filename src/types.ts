/**
 * 类型接线层。
 *
 * 这里只做两件事：
 * 1) 把真实 DSH 包的类型增强（`declare module '@deepseek-ai/cordis'`）拉进来，
 *    这样 `ctx.tools` / `ctx.systemPrompt` / `ctx.llm` 与
 *    `agent/session-start` / `agent/status` 等事件才是"真实存在的"；
 * 2) 重新导出本插件用到的少量类型，避免每个模块各自 import 一堆包。
 *
 * 注意：全部使用 `import type`，构建产物里没有任何 `@deepseek-ai/*` 运行时依赖。
 * 插件安装到 DSH profile 后，这些服务由宿主提供。
 *
 * @module dsh-dream-reflect-lite/types
 */

import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'

export type { Agent } from '@deepseek-ai/dsh-agent'
export type { Context } from '@deepseek-ai/cordis'
export type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
export type { LlmRuntime, Message } from '@deepseek-ai/dsh-llm'
