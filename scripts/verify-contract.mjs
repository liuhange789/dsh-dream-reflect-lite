/**
 * 真实运行期契约验证（不是单测替身）。
 *
 * 用的是宿主 profile 里**真实的服务实现**：
 * - `@deepseek-ai/cordis` 的 Context
 * - `@deepseek-ai/dsh-system-prompt` 的 SystemPrompt
 * - `@deepseek-ai/dsh-tools` 的 ToolRuntime
 * 然后把**构建产物** `lib/index.js` 以 cordis 插件对象的形式装进去，
 * 走的是和 Loader 完全一样的注册链路（inject → apply → register）。
 *
 * 覆盖的"真机"风险点：
 * 1. 工具注册契约（`output.schema` / `output.render` / `execute`）是否被真实运行时接受；
 *    顺便做一个反向对照：故意注册缺 output 的工具，确认运行时真的会抛，证明校验不是摆设。
 * 2. `systemPrompt.section` 注册后是否真的出现在装配出来的提示词里。
 * 3. 工具经 `ToolRuntime.execute` 真正执行：参数校验 → execute → render 全链路。
 * 4. 卡片文件读写、300 字上限、最近 3 张选取、启发式提取，全部在真实临时目录里跑。
 *
 * 依赖：先 `npm run build`，并执行过 `npm run link-host-types`（junction 到宿主的 @deepseek-ai）。
 * 用法：node scripts/verify-contract.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

import * as plugin from '../lib/index.js'
import { renderCard } from '../lib/card.js'
import { digestEvents, heuristicFacts } from '../lib/extract.js'
import { appendCard, readRecentCards } from '../lib/store.js'
import { buildCardsSection, registerCardsSection } from '../lib/prompt.js'

let checks = 0
function ok(label, detail = '') {
  checks += 1
  console.log(`  ✓ ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const workspace = mkdtempSync(join(tmpdir(), 'dream-reflect-verify-'))
const cardsDir = join(workspace, '.dsh', 'reflections')
mkdirSync(cardsDir, { recursive: true })

writeFileSync(join(cardsDir, '2026-11-08.md'), '## 08:00 · heuristic · 1 条\n- 更早的卡片，不应该出现在最近 3 张里\n', 'utf8')
writeFileSync(join(cardsDir, '2026-11-09.md'), '## 09:10 · heuristic · 2 条\n- 工具链：bash×3、edit×2\n- 关键路径：src/a.ts\n', 'utf8')
writeFileSync(join(cardsDir, '2026-11-10.md'), '## 18:20 · llm · 2 条\n- 该项目用 pnpm，不要用 npm install\n- 测试命令是 pnpm test --filter host\n', 'utf8')
writeFileSync(join(cardsDir, '2026-11-11.md'), '## 09:30 · llm · 1 条\n- 卡片写入路径是 {workspace}/.dsh/reflections/{date}.md\n', 'utf8')

const previousCwd = process.cwd()
process.chdir(workspace)

try {
  console.log('\n[1] 真实 cordis Context + 真实 ToolRuntime / SystemPrompt 装载插件')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })

  const recall = ctx.tools.get('recall_reflections')
  const reflectNow = ctx.tools.get('reflect_now')
  assert.ok(recall, 'recall_reflections 未注册')
  assert.ok(reflectNow, 'reflect_now 未注册')
  assert.equal(typeof recall.output.render, 'function')
  assert.equal(typeof recall.output.schema, 'object')
  ok('两个工具都注册成功', 'recall_reflections / reflect_now')

  console.log('\n[2] 反向对照：真实运行时确实会拒绝缺 output 的工具')
  let rejected = false
  try {
    ctx.tools.register({ name: 'bad_tool', description: 'no output', parameters: { type: 'object', properties: {} }, async execute() { return {} } })
  } catch (error) {
    rejected = /must declare output/.test(String(error instanceof Error ? error.message : error))
  }
  assert.equal(rejected, true, '运行时没有拒绝缺 output 的工具，说明这个校验不可信')
  ok('缺 output 的工具被运行时拒绝', 'tool must declare output')

  console.log('\n[3] 通过真实 ToolRuntime.execute 执行 recall_reflections')
  const result = await ctx.tools.execute({
    callId: 'verify-call-1',
    name: 'recall_reflections',
    arguments: { limit: 2 },
    signal: new AbortController().signal,
  })
  const serialized = JSON.stringify(result)
  assert.ok(serialized.includes('2026-11-11'), `执行结果不含最新卡片日期：${serialized.slice(0, 300)}`)
  assert.ok(serialized.includes('pnpm test --filter host'), '执行结果不含次新卡片内容')
  assert.equal(serialized.includes('更早的卡片'), false, 'limit=2 却返回了第 4 张卡片')
  ok('limit=2 只返回最近两张', '2026-11-11 + 2026-11-10')

  console.log('\n[4] reflect_now 在无 agent 的调用下给出明确的未写入原因（不假装成功）')
  const reflectResult = await ctx.tools.execute({
    callId: 'verify-call-2',
    name: 'reflect_now',
    arguments: {},
    signal: new AbortController().signal,
  })
  const reflectSerialized = JSON.stringify(reflectResult)
  assert.ok(reflectSerialized.includes('"written":false'), reflectSerialized.slice(0, 300))
  ok('未写入时返回 written=false + note', '没有关联 agent')

  console.log('\n[5] systemPrompt 注入：真实装配结果里能看到卡片')
  const cards = readRecentCards(workspace, '.dsh/reflections', 3)
  assert.equal(cards.length, 3, `最近卡片应取 3 张，实际 ${cards.length}`)
  assert.equal(cards[0].date, '2026-11-11', '最新卡片未排在最前')
  assert.equal(cards.some(card => card.date === '2026-11-08'), false, '第 4 张卡片被误取')
  const sectionText = buildCardsSection(cards, 2400)
  const disposeSection = ctx.systemPrompt.section({ name: 'dream-reflect:recent-cards', order: 500, text: sectionText })
  const assembly = await ctx.systemPrompt.assemble({})
  const rendered = renderPrompt(assembly)
  assert.ok(rendered.includes('工作区反思卡片'), '装配后的提示词里没有卡片标题')
  assert.ok(rendered.includes('该项目用 pnpm'), '装配后的提示词里没有卡片正文')
  const sectionIndex = rendered.indexOf('工作区反思卡片')
  assert.ok(sectionIndex > 0, '卡片 section 位置异常')
  ok('卡片确实进入了装配后的 systemPrompt', `section 起始于第 ${sectionIndex} 字符`)
  disposeSection()

  console.log('\n[6] registerCardsSection 在子作用域下同样生效')
  const childScope = ctx.extend({})
  const fakeAgent = { ctx: childScope, session: { header: { cwd: workspace } } }
  const dispose2 = registerCardsSection(fakeAgent, sectionText, 500)
  assert.equal(typeof dispose2, 'function', 'registerCardsSection 没有返回注销函数')
  dispose2()
  ok('返回可注销的 section disposer')

  console.log('\n[7] 卡片渲染：300 字上限与来源标注')
  const longFacts = Array.from({ length: 5 }, (_, index) => `第 ${index + 1} 条事实：${'很长的内容'.repeat(30)}`)
  const card = renderCard({ facts: longFacts, source: 'heuristic', at: new Date('2026-11-11T09:30:00') }, { maxCardChars: 300 })
  const bulletChars = card.split('\n').filter(line => line.startsWith('- ')).reduce((sum, line) => sum + line.length - 2, 0)
  assert.ok(bulletChars <= 300, `卡片正文 ${bulletChars} 字，超过 300`)
  assert.ok(card.startsWith('## 09:30 · heuristic'), `卡片标题异常：${card.split('\n')[0]}`)
  ok('超长事实被截断到 300 字以内', `实际 ${bulletChars} 字`)

  console.log('\n[8] 真实落盘：appendCard 追加到当天文件，不覆盖同一天已有内容')
  const writtenPath = await appendCard(workspace, '.dsh/reflections', card, new Date('2026-11-11T10:00:00'))
  assert.equal(writtenPath, join(cardsDir, '2026-11-11.md'), `落盘路径异常：${writtenPath}`)
  const onDisk = readFileSync(writtenPath, 'utf8')
  assert.ok(onDisk.includes('## 09:30 · llm'), '同一天已有卡片被覆盖')
  assert.ok(onDisk.includes('## 09:30 · heuristic'), '新卡片没有追加进去')
  ok('同一天文件追加而非覆盖', writtenPath)

  console.log('\n[9] 启发式提取：只依据会话日志里的客观结构')
  const now = Date.now()
  const events = [
    { seq: 1, time: now, type: 'user/message', data: { content: [{ type: 'text', text: '给 host 包加上类型检查并在 CI 里跑通' }], source: { kind: 'user' } } },
    { seq: 2, time: now, type: 'tool/call', data: { name: 'read', arguments: '{"path":"D:/proj/host/src/index.ts"}' } },
    { seq: 3, time: now, type: 'tool/call', data: { name: 'edit', arguments: '{"path":"D:/proj/host/src/index.ts"}' } },
    { seq: 4, time: now, type: 'tool/call', data: { name: 'edit', arguments: '{"path":"D:/proj/host/package.json"}' } },
    { seq: 5, time: now, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', callId: 'c1', isError: true, content: [{ type: 'text', text: 'TS2345: Argument of type string is not assignable' }] }] } } },
    { seq: 6, time: now, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已在 CI 中加入 tsc --noEmit' }] } } },
  ]
  const digest = digestEvents(events, 200)
  const facts = heuristicFacts(digest, { maxFacts: 5 })
  assert.ok(facts.length >= 3 && facts.length <= 5, `启发式事实条数 ${facts.length}，应为 3–5`)
  assert.ok(facts.some(fact => fact.includes('工具链') && fact.includes('edit×2')), `缺少工具链事实：${facts.join(' | ')}`)
  assert.ok(facts.some(fact => fact.includes('TS2345')), `缺少踩坑事实：${facts.join(' | ')}`)
  assert.ok(facts.some(fact => fact.includes('package.json')), `缺少配置事实：${facts.join(' | ')}`)
  ok('启发式事实可对上原始日志', `${facts.length} 条`)

  console.log('\n[10] 插件卸载正常')
  ctx.dispose?.()
  ok('ctx.dispose() 未抛错')

  console.log(`\n全部 ${checks} 项契约验证通过。`)
} finally {
  process.chdir(previousCwd)
  rmSync(workspace, { recursive: true, force: true })
}
