/**
 * 卡片文件的读写。
 *
 * 目录结构：`{workspace}/.dsh/reflections/{YYYY-MM-DD}.md`
 * - 一天一个文件，同一天的多次沉淀按时间追加；
 * - 全部是普通 md，用户可直接编辑/删除，插件不维护索引文件；
 * - 读卡片用同步 API：会话启动那一刻必须确定性地拿到卡片，异步读会和
 *   systemPrompt 首次装配抢跑，导致偶尔漏注入（静默且难查）。
 *
 * @module dsh-dream-reflect-lite/store
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

export interface CardFile {
  /** 文件名里的日期戳（YYYY-MM-DD）。 */
  readonly date: string
  /** 绝对路径。 */
  readonly path: string
  /** 文件全文。 */
  readonly text: string
}

const CARD_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/

/** 会话头里的 cwd 缺失时的兜底：用进程工作目录，宁可写到当前目录也不要静默不写。 */
export function resolveWorkspace(cwd: string | undefined): string {
  if (typeof cwd === 'string' && cwd.trim().length > 0 && isAbsolute(cwd)) return cwd
  return process.cwd()
}

/** 卡片目录绝对路径，并保证它确实落在工作区内。 */
export function reflectionDir(workspace: string, relativeDir: string): string {
  const dir = resolve(workspace, relativeDir)
  const root = resolve(workspace)
  if (dir !== root && !dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    // 走到这里说明 relativeDir 被解析到了工作区外，回退到默认目录而不是越界写文件。
    return join(root, '.dsh', 'reflections')
  }
  return dir
}

/** 本地时区的 YYYY-MM-DD（卡片按人所在时区分天，不用 UTC）。 */
export function localDateStamp(at: Date): string {
  const year = at.getFullYear()
  const month = `${at.getMonth() + 1}`.padStart(2, '0')
  const day = `${at.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 追加一张卡片，返回落盘路径。
 * 目录不存在就建；同一天的文件已存在就追加，不覆盖用户的编辑。
 */
export async function appendCard(
  workspace: string,
  relativeDir: string,
  card: string,
  at: Date,
): Promise<string> {
  const dir = reflectionDir(workspace, relativeDir)
  const file = join(dir, `${localDateStamp(at)}.md`)
  await mkdir(dir, { recursive: true })
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  await appendFile(file, `${separator}${card}`, 'utf8')
  return file
}

/**
 * 读取最近 N 张卡片（按日期倒序）。
 * 文件不存在、目录不存在都返回空数组 —— 规格要求"文件不存在就静默跳过"。
 */
export function readRecentCards(
  workspace: string,
  relativeDir: string,
  limit: number,
): CardFile[] {
  if (limit <= 0) return []
  const dir = reflectionDir(workspace, relativeDir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const dated = names
    .map(name => ({ name, match: CARD_FILE_PATTERN.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .map(entry => ({ name: entry.name, date: entry.match[1] ?? '' }))
    .filter(entry => entry.date.length === 10)
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, limit)

  const cards: CardFile[] = []
  for (const entry of dated) {
    const path = join(dir, entry.name)
    try {
      if (!statSync(path).isFile()) continue
      cards.push({ date: entry.date, path, text: readFileSync(path, 'utf8') })
    } catch {
      // 单个文件读失败不影响其余卡片。
    }
  }
  return cards
}
