# @liuhange/dsh-dream-reflect-lite

轻量级跨会话反思卡片插件，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）设计。

一句话：**这一轮干完了就顺手记 3–5 条可复用的经验，下一个会话自动带上最近 3 张卡片。**

和重度方案 `dsh-dream-reflection` 的差别：没有定时器、没有隔离区、没有审批流。卡片就是普通 Markdown 文件，你能看、能改、能删。

---

## 它到底做了什么

### 一半：沉淀（轮次结束时）

- 触发点：`agent/status` 变成 `idle`，也就是**这一轮真的做完了**。
- 取这一轮新增的会话事件（工具调用 / 文件路径 / 失败信息 / 人类诉求），提炼 3–5 条事实。
- 追加写入 `{workspace}/.dsh/reflections/{YYYY-MM-DD}.md`（一天一个文件，多次沉淀按时间追加，不覆盖你手改的内容）。
- 门槛：这一轮至少有 `minToolCalls`（默认 3）次工具调用才写卡片，闲聊不写。没到门槛时不清零，会累计到下一轮。

### 另一半：回放（新会话启动时）

- 触发点：`agent/session-start`。
- 读该工作区最近 3 张卡片，以 `systemPrompt.section()` 注册到**该 agent 作用域**的提示词末尾（`order=500`，约定里 100–199 是工具指引，所以 500 已经在末尾）。
- 目录或文件不存在 → 什么都不做，静默跳过（不报错、不刷日志）。
- 注入文本里明确写了"仅作参考，与当前指令冲突时以当前指令为准"，避免历史经验盖掉你当下的要求。

### 两个工具

| 工具 | 作用 |
|---|---|
| `recall_reflections` | 读当前工作区最近的卡片，可 `limit` 限制条数、`query` 关键词过滤。 |
| `reflect_now` | 立刻把当前会话沉淀成一张卡片（跳过 `minToolCalls` 门槛，适合会话中途主动收口）。 |

---

## 提炼方式：真模型优先，启发式兜底（都如实标注）

`mode` 决定用哪条路，卡片标题里会写明这条是谁产出的（`llm` / `heuristic` / `manual`）。

**1. `llm` 路径是真的调模型，不是假装。**

用的是 DSH 宿主真实存在的入口：`ctx.llm.stream(GenerateOptions)`（`@deepseek-ai/dsh-llm` 的 `LlmRuntime`）。

- 路由不猜：取本次会话日志里最后一条 `request/header` 的 `header.config`，那就是这次会话正在用的 provider/model；也可以用 `config.provider` + `config.model` 显式覆盖。
- 没设 `purpose`：`GenerateOptions.purpose` 的联合类型只有 `'compaction'`、`'session-title'`，硬塞一个自定义值等于撒谎，所以留空。
- 模型只给 1–2 条事实时判定为不可用（规格要求 3–5 条），会记 warning 并降级。
- `mode: 'llm'` 时模型不可用就**不写卡片**，不会偷偷换成启发式结果糊弄你。

**2. `heuristic` 路径完全不用模型，只读会话日志里的客观结构：**

- 工具链：`bash×6、read×4、edit×3（共 13 次调用）`
- 关键路径：从工具参数里抽出的文件路径
- 配置改动：命中的 `package.json` / `tsconfig*.json` / `*.yml` 等
- 踩坑：失败工具结果的原文片段
- 目标：这一轮第一条人类提问
- 产出：最后一段助手文本

它不总结语义、不猜测，所以每条都能在会话里对上号。**它不产生新信息，只做结构化压缩** —— 这是它的能力上限，也是它不会编造的原因。

`mode: 'auto'`（默认）= 先试模型，模型不可用/超时/只给出不足 3 条 → 降级启发式。

---

## 安装

```bash
dsh plugin --profile <your-profile> add @liuhange/dsh-dream-reflect-lite
```

插件自带 `dsh.bundle.patch` 指向 `cordis.patch.yml`，内容只有 loader 真正支持的 `- insert:` 形状：

```yaml
- insert:
    - id: "@liuhange/dsh-dream-reflect-lite"
      name: "@liuhange/dsh-dream-reflect-lite"
```

（旧的 `target/action/entry` 形状会被 loader 静默跳过，装上等于没插进去，本插件不使用。）

---

## 配置

全部可选，写在 profile 的 `cordis.patch.yml` 或 `--patch` 覆盖层里：

```yaml
- id: '@liuhange/dsh-dream-reflect-lite'
  config:
    mode: auto              # auto | llm | heuristic
    maxFacts: 5             # 每张卡片几条事实（3–5）
    maxCardChars: 300       # 卡片正文硬上限（80–300）
    minToolCalls: 3         # 一轮至少几次工具调用才沉淀
    recentCards: 3          # 新会话加载几张卡片
    loadOnStart: true
    skipSubagentSessions: true
    provider: deepseek      # 可选，与 model 成对出现才生效
    model: deepseek-chat
    timeoutMs: 20000
    maxInputChars: 6000
    relativeDir: .dsh/reflections
    promptOrder: 500
    promptMaxChars: 2400
    enabled: true
```

配置解析是"能自愈就自愈"：数值越界会收敛到区间内、未知键忽略、`provider`/`model` 只给一个则一起忽略，**每一次纠正都会写 warning 日志**，不会静默改变行为。`enabled: false` 时插件完全不动作（不注册工具、不注入、不沉淀）。

---

## 卡片长什么样

`{workspace}/.dsh/reflections/2026-11-11.md`：

```markdown
## 10:42 · llm · 4 条
- 该项目用 pnpm workspace，装依赖走 pnpm -w
- 类型检查命令是 npx tsc -p host/tsconfig.json --noEmit
- 构建产物在 host/lib，package.json 的 main 指向它
- 踩坑：直接写 C 盘路径会被 sandbox 拒
<!-- dsh-dream-reflect-lite model=deepseek/deepseek-chat toolCalls=17 session=abc123 -->
```

想删就删整个文件，想改就直接编辑 —— 插件不维护索引，下次读取按文件名日期倒序取。

---

## 隐私边界（请务必知道）

`mode: auto` / `llm` 时，这一轮的**结构化摘要**（工具名、参数片段、文件路径、失败信息、人类诉求、最后一段助手文本，合计上限 `maxInputChars`，默认 6000 字符）会发给**你自己配置的模型服务**做提炼。不会发往任何第三方。不想让内容离开本机就设 `mode: heuristic`。

---

## 验证情况（哪些是真跑过的，哪些没有）

这个插件是按"单测全绿但真机装不上"的教训写的，所以把验证分层写明：

**真跑过的：**

1. **类型检查对着本机真实 DSH 声明跑**：`tsconfig` 通过 junction 指向 `~/.dsh/profiles/node_modules/@deepseek-ai`（运行时真正加载的那份 0.1.0-rc.7），不是 npm 上过期的 0.0.1-rc.x。`npx tsc --noEmit` 零错误 —— 说明本插件用到的 `ctx.tools.register`、`ctx.on('agent/status' | 'agent/session-start')`、`ctx.systemPrompt.section`、`ctx.llm.stream`、`ToolDefinition`、`session.header.cwd/origin` 签名都对得上真实源码。
2. **真实 pnpm 安装进真实 profile**：`dsh plugin add <tarball>` 成功，`node_modules` 里能解析到，`.d.ts` 与 `cordis.patch.yml` 都随包发了。
3. **真实 Loader 装配确认插进去了**：`dsh --profile headless --dump-config` 的输出里出现了 `# == @liuhange/dsh-dream-reflect-lite` 及其 `id`/`name`；`--patch` 覆盖层也能正确合并 `config`。
4. **真实运行时契约**：`npm run verify:contract` 用真实的 `cordis` Context + 真实 `SystemPrompt` + 真实 `ToolRuntime` 装载构建产物，10 项全过：
   - 两个工具被真实运行时接受；
   - 反向对照：故意注册缺 `output` 的工具，运行时确实抛 `tool must declare output`（证明校验不是摆设）；
   - 经 `ToolRuntime.execute()` 真正执行 `recall_reflections`，`limit=2` 只返回最近两张；
   - 卡片 section 真的出现在 `renderPrompt(assemble())` 的结果里；
   - 300 字上限、同日追加不覆盖、最近 3 张选取、启发式事实对齐原始日志。

**没跑过的（如实说明）：**

- **完整 agent 循环 + 真实模型的端到端**没能在本机跑通。原因与插件无关：本机这份 DSH 在 `typert-loader` 阶段就挂了 ——
  ```
  @deepseek-ai/dsh-llm invocation "@deepseek-ai/dsh-llm#llm/discoverModels"
  parameter codec is not backed by a zod v4 schema
  ```
  复现：`dsh --profile web`（**没有安装本插件的 profile**）报同一个错，说明这是本机 DSH checkout 里 zod 版本不匹配的既有问题。修好之后，`dsh --profile headless "<task>"` 即可跑完整链路。这一条没有绕过、也没有假装跑过。

**已知限制：**

- DSH 没有 `session-end` 事件，所以"会话结束"落地为"这一轮结束（`idle`）"。一个会话多轮工作会产出多张卡片，按天累积在同一个文件里。
- 沉淀是 `idle` 之后的异步后台工作，进程被强杀时这一轮可能来不及落盘（不会损坏已有卡片，最坏是少一张）。
- 子代理会话默认跳过（`skipSubagentSessions`），避免子任务噪声污染工作区经验。
- 卡片按**本地时区**分天（`YYYY-MM-DD`），跨时区协作时同一天的文件名可能不一致。
- 只做"最近 N 天卡片"的粗粒度回放，不做相关性检索；卡片多了以后要靠 `recall_reflections` 的 `query` 手动过滤。
- 模型路由取自会话日志的 `request/header`；如果会话从未发起过请求（纯本地无模型的会话），`auto` 模式会直接落到启发式。

---

## 开发

```bash
npm install
npm run link-host-types     # junction 到本机 ~/.dsh/profiles/node_modules/@deepseek-ai
npm run typecheck           # 对着真实 DSH 声明检查
npm run build
npm run verify:contract     # 真实运行时契约验证
npm pack --dry-run
```

`link-host-types` 存在的意义：npm 上公开的 `@deepseek-ai/*` 版本落后于本机运行时，按 registry 版本写代码就会踩"编译过了但真机跑不了"。所以本地类型必须来自宿主。

源码结构（每个文件只干一件事）：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 唯一入口：事件接线、生命周期、错误兜底 |
| `src/config.ts` | 配置校验与自愈 |
| `src/extract.ts` | 启发式提取（纯函数，只吃会话日志） |
| `src/model.ts` | 真模型提炼（`ctx.llm.stream`）+ 路由解析 |
| `src/card.ts` | 卡片渲染与 300 字裁剪 |
| `src/store.ts` | 卡片文件读写、最近 N 张选取 |
| `src/prompt.ts` | 注入文本拼装 + section 注册 |
| `src/tools.ts` | 两个工具定义（真实 DSH 工具契约） |

## License

MIT
