# 交接文档 · dsh-agent-soul `0.9.14`

> 给接手的人（或 AI）。读完这一份就能开工，不需要翻聊天记录。
> 写作时间：2026-11-08（0.9.14 于 2026-11-10 更新）· tag `v0.9.14` · npm `latest = 0.9.14`

---

## 最重要的一条（先读这个，再看别的）

**你负责改，不负责发。**

- ❌ **不要** `npm publish`
- ❌ **不要** 打 tag（`git tag`）
- ❌ **不要** 改 `package.json` 的 `version`
- ❌ **不要** 动 `CHANGELOG.md`

做完之后**交付**（分支 + diff + 进度档案，格式见 §8），由委托方的常驻助手**复核后统一发布**。
发布这件事牵涉版本号、CHANGELOG、tag、npm、安装副本同步五处一致性，还有一个我踩过的坑：
`npm publish` 之后立刻 `npm view` 会报 404，必须等 2–4 分钟传播 —— 这些由发布者一个人扛，
不要让两边各发一半。

> 上一轮的实际情况可以佐证：上一版（`0.9.8`，含 R13 的 23 条修复）就是外部 AI 改的，
> 交付了分支 + diff + 进度档案，由本人复核后发的。**复核时发现其中一条（#1）其实没修好** ——
> 所以 §8 的交付物里必须自带「不修就红」的证据，别只写「已修」。

---

## 0. 一句话现状

这是一个 DSH/Cordis 插件，给「糖糖」这个 AI 伴侣做**人格 + 记忆 + 心情 + 目的 + 笔记 + 日记**。
`0.9.1`–`0.9.8` 八天里清掉了全部 14 条 P1 与大部分 P2，目前**没有会让插件罢工的已知缺陷**，
剩 12 条「特定条件下才发作」的问题（见 §5）。

| 指标 | 数值 |
|---|---|
| 测试 | **91** 个测试文件 / 0 失败；契约 **11** / 0 |
| 代码量 | `lib/` 97 个文件 / ~19.9k 行 |
| 运行时依赖 | **零**（`dependencies` 为空，刻意如此） |
| 支持 | Node ≥ 22.19；CI 跑 Node 22 + 24 + Windows |
| 发布物 | `lib assets docs tools cordis.patch.yml README CHANGELOG LICENSE THIRD-PARTY-NOTICES LICENSES` |

---

## 1. 代码从哪来

```
仓库：https://github.com/danshuyue/dsh-agent-soul
分支：main（HEAD = b57d856）
版本：0.9.8（package.json / npm / tag v0.9.8 三者一致）
安装副本：C:\Users\Administrator\.dsh\plugins\dsh-agent-soul   ← 与 main 同步
运行日志：C:\Users\Administrator\.dsh\agents\soul.log
```

**开工第一步：确认你拿到的是不是这个版本。**

```bash
git log --oneline -1        # 应为 b57d856 或其后代
node -e "console.log(require('./package.json').version)"   # 应为 0.9.8
git tag --list | tail -3    # 应含 v0.9.8
```

---

## 2. 三条命令，先跑通再动手

```bash
export DSH_HOME=/tmp/soul-dev TZ=UTC   # Windows: $env:DSH_HOME="..."; $env:TZ="UTC"
npm test          # 84 个文件，约 30–60 秒；期望「汇总：收集 84 / 执行 84 / 失败 0」
npm run lint      # 期望「lint: 没有发现问题」
npm run test:contracts   # 11 个，期望 0 失败
```

`DSH_HOME` **必须**指向临时目录 —— 否则测试会写真实用户数据。
`npm test` 会先跑 `build-client.mjs` 再跑全量（构建失败会直接红）。

---

## 3. 结构地图（先看这 8 个文件，够你改 80% 的事）

```
lib/index.js             插件入口：注册工具/注入段/HTTP/定时器。改行为先看这里
lib/env.js               note() 日志、appendLogLine、sanitizeLogText、健康计数
lib/paths.js             所有落盘路径 + atomicWrite（所有写盘都走它）
lib/store.js             门面：把各 state 模块的导出汇总（契约快照盯的就是它）
lib/host/runtime/        宿主装配：turns（轮次/游标）inject（注入段）tick（每回合维护）
lib/memory/              记忆卡：card-io（读写/损坏迁移）card（合并/ref/搜索）
lib/diary/               日记：scheduler（定时/看门狗）compose（拼素材）feed（流水/选段）
lib/http/                设置页 API：server（路由分发/鉴权）routes/* middleware
lib/client/*.js          设置页前端片段 → 由 tools/build-client.mjs 拼成 lib/client.js
```

**注入顺序**（`ctx.systemPrompt.context({order})`，改顺序会影响提示词结构）：

```
230 心情 / 240 目的 / 245 笔记 / 250 记忆 / 260 人格 / 270 数据边界
```

---

## 4. 工作纪律（红线，破了会出事）

### ① 测试是门禁，不是装饰

```bash
npm test                 # 全量
npm run test:contracts   # 契约：导出集合、路由分支、行为 golden、依赖图、探针
```

新增测试就放进 `tests/`，命名 `xxx.test.js`，`tools/run-tests.mjs` 会自动收集（**不需要登记**）。
每个文件有 180 秒超时，可用 `--timeout=<秒>` 覆盖。

**测试模板**（仓库里的自建 runner 都是这个形状）：

```js
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)
const sandbox = mkdtempSync(join(tmpdir(), 'soul-x-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents'), { recursive: true })

let passed = 0, failed = 0
const ok = (c, n) => { if (c) { passed++; console.log(`  ✓ ${n}`) } else { failed++; console.error(`  ✗ ${n}`) } }

// ... 断言 ...

console.log(`\n结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
```

### ② 修 bug 必须证明「不修就红」（REDGREEN）

改完代码，**把源码退回旧写法**（改源文件，不要用运行时钩子），跑测试看它红；再恢复。
只靠「改完绿了」不算验证 —— 可能你加的断言本来就是恒真的。

> 真实教训：`0.9.8` 修 `/diary/list` 的 UTF-8 截断，第一版测试在前面加了 25 字节前缀，
> 让 400 字节的切点正好落在字与字之间 —— **修没修都是绿的**。是毒化复核才发现的假绿。
> 现在这条测试用纯中文正文（`400 % 3 = 1`），毒化后必红。

### ③ 契约快照只能走正规通道

`tests/contract/` 下的 `exports.snapshot.json`、`behavior-golden.json` 是**基线**，
**不允许手改**。变了就：

```bash
SOUL_UPDATE_SNAPSHOT=1 SOUL_SNAPSHOT_REASON='中文说明为什么变' node tests/contract/exports.snapshot.test.js
```

理由会自动记进 `tests/contract/SNAPSHOT_CHANGES.md`。**没写理由的刷新等于作弊。**

### ④ 前端改了片段必须重建

```bash
node tools/build-client.mjs     # lib/client/*.js → lib/client.js
```

CI 会 `git diff --exit-code -- lib/client.js tests/contract/`，忘了重建直接红。
构建脚本会做语法/重名/符号表检查。

### ⑤ 不许加运行时依赖

`dependencies` 必须保持为空。这不是洁癖：插件要在用户机器上零安装跑起来。

### ⑥ 零宽字符/混合宽度这类「看起来没事」的输入，要单独想

`lib/core/prompt-guard.js` 负责把不可信数据包进边界标签。它处理：ASCII 标签、全角标签、
混合宽度（`<`…`＞`）、零宽字符（`\u200B-\u200D`）、控制字符。

### ⑦ lint 是硬门禁

`npm run lint` → `tools/lint.mjs`，只查两条（都是真出过问题的）：
未使用的 import、测试里的恒真断言 `ok(true, …)`。
真需要「到这里没抛就算过」，行尾写 `// lint-allow:ok-true` 并说明理由。

### ⑧ 只在分支上改，不发布

```bash
git switch -c fix/your-topic main   # 从干净 main 拉
```

**不 `npm publish`、不打 tag、不改 `package.json` 的 `version`、不改 `CHANGELOG.md`。**
版本号 / 发版 / tag / 安装副本同步都由复核方统一做（见 §8）。

理由不只是「分工」：这五处必须同时改对，两边各改一半就会出现
「npm 上是 0.9.9、tag 是 v0.9.8、package.json 是 0.10.0」这种再也对不上的状态。

---

## 5. 当前遗留（1 条）

> 完整版在 [`docs/KNOWN-ISSUES.md`](KNOWN-ISSUES.md)，每条带代码位置、影响、建议改法、验证程度（A 实测 / B 读代码 / C 仅归档）。
>
> **`0.9.12` 之后，功能类 / 清理类 / 重构类已知问题全部清零。** 只剩这一条，而且**做不了**。

| # | 问题 | 位置 | 为什么现在做不了 |
|---|---|---|---|
| **23** | 「错误边界」接不住**渲染期**异常 → 白屏 | `lib/client/app.js` | 需要 `React.Component` 基类；本 bundle 的作用域里只有 `h` 与几个 hook，没有 `Component`。**等宿主暴露**，别自欺欺人地改成 `try/catch`（渲染发生在 React 内部，抓不到） |

> 已清掉的（按轮次）：#28 与 #32–#35（R15）、#27（R16）、#26（R17）、
> 以及更早的 #1–#22 大部分。三个大文件都已拆完：
> `segment-memory.js`（`text()` → 三个私有函数）、`diary/compose.js`（→ `llm` / `history` / `agent`）、
> `diary/scheduler.js`（→ `deliver` + `agent`，主文件 679 → 551 行）。
>
> 还有一个**我方文档错误**已更正：`askAgentToWrite` 的 `force` 参数不是死代码，
> `regenerateDiary` 确实传了 `{ force: true }`。

### 明确「不修」的（想清楚了，别捡起来）

| 项 | 为什么 |
|---|---|
| 反代下 `isLoopbackRequest()` 恒真 | 代理会把 `remoteAddress` 变成 `127.0.0.1`，插件侧没有可靠信号区分真实远端。`DSH_SOUL_TRUSTED_PROXY` **只用于分桶与日志，不参与授权** —— 把那两个可伪造的头当授权依据就是提权漏洞 |
| 跨进程写卡不自动重写 | 已检测+告警；自动重写要给**每次**写盘加成本，而多进程并发是低频 |
| P3 大部分 | 改了不解决任何用户问题 |

### 仍「待确认」的 2 条（依赖宿主行为，仓库里验不了）

| 项 | 兜法 |
|---|---|
| 压缩会话的 `snapshotEvents` 会不会抛 | 抛了也不推进锁：游标一定推进、整卡注入只宽限一次。**报「新会话没人格」先查这里** |
| 反代 + 非默认端口下 `Origin`/`Host` 形态 | 已按规范化权威比较；被拒时 403 响应体带 `origin`/`host` 可对照 |

---

## 6. 下一轮该做什么（0.9.16 后）

👉 **本轮任务书：[`docs/R20-BRIEF.md`](R20-BRIEF.md)** —— 外部审查的 43 条，按「止血 → 门禁 → 语义 → 边界 → 文档」分五批。

先看它的第 0 节：**上一轮写的「清零」是错的**。六天后又被找出 43 条，其中 8 条是我在「清零」之后自己写进去的（H1/M4/M5/M9/M10/M25/H2/L1），全部穿过了 lint + 92 测试 + 契约 + 双平台 CI。

所以下面这条「R18 留下的接线缺口」**并入 R20 的批次 C**（门禁），不再单独排期：

### 给 `evidence.js` 的旧 mark 补「接线测试」

`moodTone` / `moodJudge` / `memoryRefine` 这三个 mark 只有**单元级**覆盖 —— 测试直接调 `mark()`。
把 `inject.js` 里那行 `mark('moodTone', …)` 删掉，R18 的测试仍然全绿。

> R19 的 ⑥ 已经示范了做法：**用 `runDiaryOnce` + 假 agent 走真实调用路径**，
> 断言「落盘文件里出现了那条记录」。同样的思路适用于 tone：
> 需要先摸清 `takeTone` 依赖哪些状态字段（我试过 `mood=30` + `moodToneEveryTurns=1` 没走到 `append`）。

### 功能面暂时不做

- **② 联想召回（assoc）暂缓**：全局记忆 92 条，三道闸下边密度建不起来，收益接近零。
  等记忆到 300~500 条、且确实「该想起来的没想起来」时再做。`docs/待做的三件事.md` 里已标注。
- **`#23`**（渲染期白屏）：等宿主暴露 `React.Component`。
- **两条「待确认」**（见第六节）：需要真实环境（压缩会话的 `snapshotEvents`、反代 `Origin` 形态）。

### ② 还剩两件事，都不是「改代码」

- **`#23`** —— 等宿主暴露 `React.Component`。在那之前别动：`try/catch` 包不住渲染期异常
  （渲染发生在 React 内部），改了只会得到一个假的错误边界。
- **两条「待确认」**（见第六节）—— 都需要**真实环境**：压缩会话的 `snapshotEvents`
  会不会抛、反代 + 非默认端口下的 `Origin`/`Host` 形态。谁遇到谁先留日志。

> 三条重构纪律（R15 / R16 / R17 三轮验证有效，照抄）：
> **先补特征测试钉住当下行为 → 再拆 → 特征测试一条不改必须全绿 → 毒化一次证明测试网有效。**
>
> 三个实践细节值得学：
> ① 特征测试**单独一个提交**、并且要在**拆分之前**就在旧代码上全绿 —— 否则它可能断言的是实现；
> ② 拆分用**脚本按段落切分**，别手抄（R16 的做法）—— 手抄一定会少一个空格或漏一行；
> ③ 毒化点/毒化写法要选对：R15 第一版选了确定性路径（重算字节相同 → 不红），
> R16 第一版把条件写成 `A || B && false`（优先级让毒化失效）——
> **两次都是毒化写错，不是测试无效**。毒化不红时先怀疑毒化本身。

---

## 7. 环境坑（Windows 为主，踩过才知道）

| 坑 | 表现 | 解法 |
|---|---|---|
| PowerShell 5.1 的 `Get-Content`/`ConvertFrom-Json` | 中文变乱码、UTF-8 被当 GBK | 用 `write`/`read` 工具编辑文件；或 `[System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)` |
| `Set-Content -Encoding utf8` | 加 BOM，JSON 解析失败 | 用 `[System.IO.File]::WriteAllText($p, $s, (New-Object Text.UTF8Encoding($false)))` |
| CRLF | 多行字符串 `match`/`replace` 锚点对不上 | 用 `\r?\n` 的正则，别用字面换行 |
| 测试互相踩 `DSH_HOME` | 随机 ENOENT / 数据串味 | 每个测试文件 `mkdtempSync` 独立目录，结束时删 |
| 时区 | 日期相关断言漂 | 跑测试固定 `TZ=UTC`；代码里**不要**再用 `toISOString().slice(0,10)` 当本地日期 |
| `gh` 偶发 502 | 查不到 CI | 抓 `https://github.com/<repo>/actions` 页面看「completed successfully / failure」 |
| npm publish 后立刻 `npm view` | 报 404 / notarget | **发布方的事**；你在交付里别碰发布，就不会踩到 |

---

## 8. 交付流程（你只交付，不发布）

### 8.1 你要做的

```bash
# 1. 从干净的 main 拉一个分支（不要直接在 main 上改）
git switch -c fix/your-topic main

# 2. 改代码 + 补测试 + 走 REDGREEN（§4②）

# 3. 验证（三道，缺一不可）
npm run lint
npm test
npm run test:contracts
git diff --exit-code -- lib/client.js tests/contract/   # 必须干净

# 4. 提交到**自己的分支**（不推 main）
git add -A && git commit -m "..."

# 5. 打包交付物（见 8.2）
```

**不要做的事**：`npm publish` / `git tag` / 改 `package.json` 的 `version` / 改 `CHANGELOG.md`。

> 版本号、CHANGELOG、tag、npm、安装副本这五处的一致性由发布者统一处理。
> 你改了版本号，合并时就要多解一次冲突，而冲突解法一旦错，发布的版本号就是错的那一个。

### 8.2 交付物（四样，缺一样复核就会慢一半）

| 交付物 | 内容 | 为什么需要 |
|---|---|---|
| **分支** | `fix/your-topic`（能 push 到远端最好；不能就给 diff） | 复核时我会直接合并 + 跑全量，比看 diff 可靠 |
| **diff 文件** | `git diff main...fix/your-topic > xxx.diff`，并报「N 文件 / +A / −D」 | 快速对账：我合并后 `git diff --stat` 必须和你报的一致 |
| **进度档案** | 每条修复一个编号：**症状 → 改法 → 证据** | 「已修」两个字在上一轮骗过人（#1） |
| **测试证据** | 每条修复对应哪个测试、断言几条、**毒化后是否变红** | 这是唯一能证明「真修了」的东西 |

**进度档案模板**（每条都这么写）：

```md
### #20 notes reconcile 按索引对位比较

- 症状：笔记页反复显示「已变更」；顺序一变就误报
- 位置：lib/notes.js:reconcile()
- 改法：改按 slug 建 Map 比较
- 测试：tests/xxx.test.js 第 3 节，5 条断言
- REDGREEN：把比较改回索引对位 → 第 4、5 条断言变红；恢复 → 绿
- 兼容性：老索引文件是否需要迁移？说明结论
```

### 8.3 复核会看什么（提前对齐，省一轮返工）

1. **合并后**全量测试 + 契约 + lint 是否仍绿（不是你那棵树绿，是**合并进 main 之后**绿）；
2. **`lib/client.js` 能不能重建**：我会跑 `node tools/build-client.mjs` 要求零 diff；
   顺带检查 `d243fd7` 加的第三方署名注释没被覆盖；
3. **有没有偷偷改既有测试**：`git diff main -- tests/` 里除了新增文件，其余改动要能解释；
4. **契约基线是否走正规通道**：`SNAPSHOT_CHANGES.md` 里有没有带理由的记录；
5. **逐条 REDGREEN 抽查**：我会挑 1–3 条自己毒化一遍，看是不是真红；
6. **有没有顺手引入新依赖 / 硬编码路径 / 平台假设**。

上一轮就是第 5 条抓出的问题：`#1` 的修复声称已修，测试也加了，
但补的测试**修没修都是绿的**（前缀字节数让 UTF-8 切点正好落在字与字之间）。

### 8.4 发布由谁做

复核通过后，由委托方的常驻助手统一执行：

```bash
# 版本号 / CHANGELOG / tag / npm / 安装副本同步 —— 这五步只在一处做
```

所以你在交付文档里**只要说清「改了什么、为什么、怎么验」**，不需要替我考虑发版。

---

## 9. 排查线索

```
C:\Users\Administrator\.dsh\agents\soul.log     ← 第一手线索，永远先看这里
```

日志是**本地时间**、带 `+08:00` 偏移。关键 tag：
`[apply]` 启动/装配 · `[api]` 接口 · `[memory]` 记忆 · `[diary]` 日记 · `[mood]` 心情 ·
`[tick]` 每回合维护 · `[extract]` 提取 · `[attest]` 装配证词。

**几条「看着像 bug 其实不是」的日志**：

| 日志 | 真相 |
|---|---|
| `[mood] 心情判定用的是自定义 provider「xxx」（不是 siliconflow）…` | 一次性告警，提醒「宿主不认识这个 provider 会让心情静默停摆」。看到它就往下翻一行确认判定是否成功 |
| `[memory]「想起来了」被去重挡空，已把去重表收到 N 条重试` | 设计好的退化：全被挡掉时缩小去重表重试，不会注入空段 |
| `[diary] 2026-11-xx 两篇都已写完，跳过` | 看门狗每 60 分钟检查一次，正常 |
| `[api] 设置页接口已注册` 后紧跟 `[diary] 看门狗已启动` | 正常启动序列，共约 11 行 |

---

## 10. 交接边界（这些不要自作主张）

1. **不要发布** —— 不 `npm publish`、不打 tag、不改版本号、不改 `CHANGELOG.md`（见 §8）。
2. **不要给鉴权加 trust-proxy 授权** —— 见 §5「明确不修」第一条。
3. **不要手改 `tests/contract/*.json`** —— 走 `SOUL_UPDATE_SNAPSHOT`。
4. **不要在读取路径写盘** —— `readCardQuietly` 就是为此而存在的：
   `loadCard` 会 `parkCorrupt`（把坏卡改名+置只读），读取路径**绝不能**用它。
5. **不要动 `lib/client.js`**（构建产物）—— 改 `lib/client/*.js` 片段后重建。
6. **不要给 `lib/index.js` 的注入段改顺序** —— 顺序决定提示词结构，改了要同步契约与文档。
7. **不要在源码里写死盘符、用户名、IP** —— 测试与公开仓库都会带上。

---

## 11. 一句话给接手的人

这个项目最大的风险不是「功能不够」，而是**「看起来绿了，其实没测到」**。
`0.9.8` 里那条 UTF-8 bug 就是这么漏出去的：修复写了、测试也补了，但补的测试是假绿 ——
而它正是上一轮外部交接时漏过来的。

所以规矩只有一条：**改完先证明「不修会红」，再证明「修了会绿」。**

至于发布：**你只管把证据备齐，发不发、什么时候发，由复核方定。**
