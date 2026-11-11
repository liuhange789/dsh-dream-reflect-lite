/**
 * 配置解析。
 *
 * 不使用 `@deepseek-ai/schemastery`：它是可选 peer，装上与否都不该影响插件可用性。
 * 这里手写校验，原则是「能自愈的配置就自愈，不能自愈的才报错」，
 * 并把每一次纠正都作为 warning 交回调用方写日志 —— 配置错了用户要能看见，
 * 而不是被静默改成别的行为。
 *
 * @module dsh-dream-reflect-lite/config
 */

/** 提取方式：auto = 先真模型、失败退启发式；llm = 只用模型；heuristic = 只用启发式。 */
export type ExtractMode = 'auto' | 'llm' | 'heuristic'

export interface ReflectConfig {
  /** 总开关。false 时插件仍然加载，但只注册工具、不做自动提取。 */
  readonly enabled: boolean
  readonly mode: ExtractMode
  /** 每张卡片最多几条事实（规格是 3–5）。 */
  readonly maxFacts: number
  /** 每张卡片正文硬上限（字符数），规格上限 300。 */
  readonly maxCardChars: number
  /** 一轮至少发生多少次工具调用才值得沉淀，避免闲聊也写卡片。 */
  readonly minToolCalls: number
  /** 新会话启动时加载几张最近卡片。 */
  readonly recentCards: number
  /** 是否在会话启动时注入卡片。 */
  readonly loadOnStart: boolean
  /** 子代理会话是否跳过（默认跳过，避免噪声卡片）。 */
  readonly skipSubagentSessions: boolean
  /** 显式指定模型路由；成对出现，缺一不生效。 */
  readonly provider?: string
  readonly model?: string
  /** 单次提取调用的超时。 */
  readonly timeoutMs: number
  /** 送给模型的会话摘要字符上限。 */
  readonly maxInputChars: number
  /** 卡片目录，相对于工作区根目录。 */
  readonly relativeDir: string
  /** systemPrompt section 排序值：约定 100–199 是工具指引，取更大值即排在末尾。 */
  readonly promptOrder: number
  /** 注入到 systemPrompt 的卡片文本上限。 */
  readonly promptMaxChars: number
}

export const DEFAULT_CONFIG: ReflectConfig = {
  enabled: true,
  mode: 'auto',
  maxFacts: 5,
  maxCardChars: 300,
  minToolCalls: 3,
  recentCards: 3,
  loadOnStart: true,
  skipSubagentSessions: true,
  timeoutMs: 20_000,
  maxInputChars: 6_000,
  relativeDir: '.dsh/reflections',
  promptOrder: 500,
  promptMaxChars: 2_400,
}

export interface ResolvedConfig {
  readonly config: ReflectConfig
  readonly warnings: string[]
}

const MODES: readonly ExtractMode[] = ['auto', 'llm', 'heuristic']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readBoolean(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  warnings: string[],
): boolean {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    warnings.push(`config.${key} 需要 boolean，收到 ${JSON.stringify(value)}，已回退为 ${String(fallback)}`)
    return fallback
  }
  return value
}

function readInteger(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
): number {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    warnings.push(`config.${key} 需要整数，收到 ${JSON.stringify(value)}，已回退为 ${fallback}`)
    return fallback
  }
  if (value < min || value > max) {
    const clamped = Math.min(Math.max(value, min), max)
    warnings.push(`config.${key}=${value} 超出 [${min}, ${max}]，已收敛为 ${clamped}`)
    return clamped
  }
  return value
}

function readString(
  source: Record<string, unknown>,
  key: string,
  warnings: string[],
): string | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    warnings.push(`config.${key} 需要非空字符串，已忽略`)
    return undefined
  }
  return value.trim()
}

/**
 * 把一个 untrusted 配置对象解析成完整配置。
 * 未知键只告警、不报错：插件升级不该因为老配置里多一个键就起不来。
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const warnings: string[] = []
  if (raw === undefined || raw === null) {
    return { config: DEFAULT_CONFIG, warnings }
  }
  if (!isRecord(raw)) {
    warnings.push(`插件配置需要对象，收到 ${typeof raw}，全部使用默认值`)
    return { config: DEFAULT_CONFIG, warnings }
  }

  const known = new Set(Object.keys(DEFAULT_CONFIG))
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) warnings.push(`未知配置键 "${key}"，已忽略`)
  }

  const rawMode = raw['mode']
  let mode: ExtractMode = DEFAULT_CONFIG.mode
  if (rawMode !== undefined) {
    if (typeof rawMode === 'string' && (MODES as readonly string[]).includes(rawMode)) {
      mode = rawMode as ExtractMode
    } else {
      warnings.push(`config.mode 只接受 auto/llm/heuristic，收到 ${JSON.stringify(rawMode)}，已回退为 auto`)
    }
  }

  const provider = readString(raw, 'provider', warnings)
  const model = readString(raw, 'model', warnings)
  if ((provider === undefined) !== (model === undefined)) {
    warnings.push('config.provider 与 config.model 必须成对出现，已一起忽略（改用会话日志里的真实路由）')
  }
  const route = provider !== undefined && model !== undefined ? { provider, model } : {}

  let relativeDir = DEFAULT_CONFIG.relativeDir
  const rawDir = readString(raw, 'relativeDir', warnings)
  if (rawDir !== undefined) {
    // 只允许工作区内的相对路径：绝对路径和 `..` 会让卡片写到工作区之外。
    if (/^([A-Za-z]:|[\\/])/.test(rawDir) || rawDir.split(/[\\/]+/).includes('..')) {
      warnings.push(`config.relativeDir 必须是工作区内的相对路径，收到 "${rawDir}"，已回退为 ${DEFAULT_CONFIG.relativeDir}`)
    } else {
      relativeDir = rawDir.replace(/^\.?[\\/]+/, '').replace(/[\\/]+$/, '')
    }
  }

  const config: ReflectConfig = {
    enabled: readBoolean(raw, 'enabled', DEFAULT_CONFIG.enabled, warnings),
    mode,
    maxFacts: readInteger(raw, 'maxFacts', DEFAULT_CONFIG.maxFacts, 3, 5, warnings),
    maxCardChars: readInteger(raw, 'maxCardChars', DEFAULT_CONFIG.maxCardChars, 80, 300, warnings),
    minToolCalls: readInteger(raw, 'minToolCalls', DEFAULT_CONFIG.minToolCalls, 1, 50, warnings),
    recentCards: readInteger(raw, 'recentCards', DEFAULT_CONFIG.recentCards, 0, 10, warnings),
    loadOnStart: readBoolean(raw, 'loadOnStart', DEFAULT_CONFIG.loadOnStart, warnings),
    skipSubagentSessions: readBoolean(raw, 'skipSubagentSessions', DEFAULT_CONFIG.skipSubagentSessions, warnings),
    ...route,
    timeoutMs: readInteger(raw, 'timeoutMs', DEFAULT_CONFIG.timeoutMs, 1_000, 120_000, warnings),
    maxInputChars: readInteger(raw, 'maxInputChars', DEFAULT_CONFIG.maxInputChars, 500, 40_000, warnings),
    relativeDir: relativeDir.length > 0 ? relativeDir : DEFAULT_CONFIG.relativeDir,
    promptOrder: readInteger(raw, 'promptOrder', DEFAULT_CONFIG.promptOrder, 200, 10_000, warnings),
    promptMaxChars: readInteger(raw, 'promptMaxChars', DEFAULT_CONFIG.promptMaxChars, 200, 20_000, warnings),
  }
  return { config, warnings }
}
