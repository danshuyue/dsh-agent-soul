# 变更记录

本项目从 `0.9.2` 起维护本文件。更早版本只能靠 git tag 和提交记录回溯 —— 这正是本文件存在的原因：
`0.8.3` 加了一道会让反代部署整页 403 的 Host 白名单，却没有任何变更说明，最后是使用方撞上并报回来的（[#1](https://github.com/danshuyue/dsh-agent-soul/issues/1)）。

格式：`## 版本 · 日期` / 变更按「新增 / 变更 / 修复 / 破坏性」分类。

---

## 0.9.15 · 2026-11-10

### 修复

- **0.9.14 的两个新功能在设置页看不见**：`diaryToTodayEnabled` / `situationEnabled` 只加了配置键、
  没加界面 —— 而「每个功能都要在设置 UI 里能关」是这个项目定过的规矩。
- **卡片只在「今天已经有一句」时才渲染**：用户什么都没看到，会以为功能没做。
  现在功能开着就一直有这张卡片；今天还没那句时给**一句轻说明**
  （「她写完私密日记、在末尾写一行「想对明天说：…」时就有了」），不是整块消失，也不催更。

### 测试

- `tests/r19-situation-to-today.test.js` 加 4 条**界面契约**断言：客户端产物里必须有这张卡片、
  两个开关、以及那句空状态说明 —— 防止「配了键忘了接界面」这类静默漏做再发生。

---

## 0.9.14 · 2026-11-10

功能增补轮 **R19**（依据 `dsh-agent-soul-0.9.8-功能增补设计.md`，按 0.9.13 的实际代码修正落点）。
两项都**不新增状态源、不新增模型调用**，各带一个总开关，关掉后逐字节等价。

### 新增 · 现实情境（④）

- 新增 `lib/core/situation.js`：**纯规则、零模型成本**地算时段（深夜 / 清晨 / 上午 / 下午 / 晚上）、
  月份与季节、节日、久未交互天数。节日表可编辑（`agents/situation.json`），读不到或写坏就用内置默认。
- 三个消费者，都不进提示词主干（否则每轮上下文随时间抖动，长缓存全废）：
  - **日记素材**：写成「（背景：11 月·秋；今天是国庆。）」，只给事实，不给「你要写得温暖一点」；
  - **目的段**：跟着「心里惦记的事」带一句短状态（`（已经 3 天没聊过了，现在是深夜。）`），
    而且**只在这一段本来就要发的时候**带，不额外开一条注入面；
  - 久未交互只看 `agents/conversations/` 的**文件名**（不读内容），60 秒缓存。

### 新增 · 昨天想对今天说的话（⑥）

- 她写完**私密日记**之后，可以在正文末尾多写一行 `想对明天说：…`；插件把它摘出来单独存
  （`agents/diary/to-today.json`，单条按天覆盖），当天每个新会话的**首轮**带进上下文，
  设置页日记卡片里能看到、能**改写 / 删掉**。
- **不新增模型调用**：搭私密篇那一次产出的末班车。没写 / 超过 30 字 / 写盘失败 → 今天就没有这句，
  不重试、不兜底、不告警。
- **不改写私密正文**：scheduler 在私密落盘后本来就会把正文读回来（给连续线用），
  所以这里只**解析**、不**改写** —— 「从不改写」比「剥完逐字节一致」更强。
  设计稿原本要「剥掉那一行」，这一版改成保留：那行话留在她自己的日记里反而更像日记。
- 跨天作废按 `date` 严格匹配，不需要清理任务；不进记忆卡、不进人格文件、不参与统计。

### 变更

- 新增配置键：`situationEnabled`（默认 true）、`diaryToTodayEnabled`（默认 true）、
  `diaryToTodayMaxChars`（默认 30，范围 10–60，`NUMBER_RANGES` 与 `normalizeConfig` 两处同步登记）。
- 新增路由 `POST /diary/to-today`（`{action:'edit'|'delete'}`）；`GET /diary/list` 多返回一个 `toToday`。
- 开关证据（0.9.13 的 `lib/evidence.js`）新增两项：`昨天那句话` 与 `现实情境`。
- **这一轮的接线是真的测过的**：毒化「scheduler 里不记那一句」+「注入分支关掉」→ 5 条断言变红，
  恢复全绿。这正是 0.9.13 记下的那个缺口（R18 的动态证据当初只有单元级覆盖）。

### 已知不做

- **② 联想召回（assoc）暂缓**：全局记忆才 92 条，三道闸下边密度建不起来，收益接近零，
  却要引入新状态文件 + 离线建边 + 拿基线对比。等记忆到 300~500 条、且确实「该想起来的没想起来」时再做。

---

## 0.9.13 · 2026-11-10

外部复检轮 **R18**（文档漂移 / 废弃键 / 开关生效证据），15 文件 / +439 −5。90 测试 / 11 契约全绿。

### 新增

- **`lib/evidence.js` —— 开关的「生效 / 未生效」证据**（这是本轮真正的东西）：
  - `mark(key, note)`：动态证据，只在**送达点**调用（语气真的进了收件箱、判定真的记了账、
    提炼真的入了库、四段真的进了装配）；
  - `statuses(cfg)`：17 个布尔开关的静态生效性 + **人话原因**（「心情关了——判定不跑，语气无从挂起」）；
  - `reportLine(cfg)`：一行三段式总览（生效 / 暂未发生 / 未生效）。
  - 输出只在三处：**启动一行 + 每日健康行 + `/state`**，绝不每轮（噪音会让人不再看日志）。
  - 动机是那次**语气链失效三天、日志一句错都没有、测试全绿** —— 开关的值不等于开关的效果。
- `/state` 新增 `switches`（开关证据）与 `legacyKeys`（配置文件里还躺着的废弃键）。

### 修复

- **介绍与实现对不上**：`package.json` 的 description 与 README 都还写着心情「不注入、无挂饰」，
  而心情语气 2026-11-01 就上线了、`soul:mood` 段每轮都进上下文。
  连带修正 4 处同款过时注释（`index.js` 头、`mood.js` 头、`cache.js` 的 `moodEnabled` 注释、
  `mood/digest.js` 的类比）—— 这 4 处是 R18 漏掉的，发布前复核补上。
- **废弃配置键不再写回配置文件**：`diarySchedule` 与 `moodOwnerName` 仍**接受**（不 400，保兼容），
  但 `saveConfig` 落盘前剔除，每个键只记一行日志；`moodOwnerName` 只在 `ownerName` 迁移完成后剔
  （不然会把老用户的迁移源数据弄丢）。`DEFAULT_CONFIG` 两键保留 —— 删了会让 `validateConfigEntry`
  开始报「未知配置项」，那是破坏性变更。

### 已知缺口（不阻塞发布）

- 动态证据目前只有**单元级**覆盖（测试直接调 `mark()`），**没有「注入链路真的会调 mark」的接线测试** ——
  把 `inject.js` 里那行 `mark('moodTone')` 删掉，25 条测试仍然全绿。
  静态那一半有真覆盖（假旋钮毒化 → 3 条红）。已记入 `docs/HANDOFF.md` §6 作为下一轮第一件事。

---

## 0.9.12 · 2026-11-10

外部复检轮 **R17（最后一个大文件）**，2 个提交 / 8 文件 / +353 −241。**对外行为零变化**：
89 测试 / 11 契约 / lint / bundle 零 diff 全绿；四个搬迁函数的**函数体在旧新位置逐字一致**。

### 重构

- **`diary/scheduler.js`（779 行五职责）拆分**（#26）：
  - `diary/deliver.js`（新）—— 投递与回执判定：`shouldAskAgain` / `askAgentToWrite` / `mtimeMsOf`
  - `diary/agent.js` —— `diaryAgent` 并入（与 R16 移进来的 `composeDiarySetup` 同属「会话获取 / 冷启动」）
  - `diary/scheduler.js` —— 只留定时器 / 双层锁 / 主流程 / `regenerateDiary` / `runCatchUp`（779 → 551 行）
- 函数体由脚本按段落切分，**逐字未改**；`askAgentToWrite` 因跨模块调用由私有改导出（已披露）。
- `lib/diary.js` 门面导出名集合（29 个）不变，`diaryAgent` 改从 `agent.js` re-export。

### 测试

- 新增 `tests/r17-deliver-feature.test.js`（11 断言），**先于拆分提交**且在旧代码上全绿：
  补上了 `shouldAskAgain` 这块**零直接覆盖**的判定矩阵（force / 不存在 / since=0 老行为 /
  旧文件重写 / 新文件不重问 / mtime 被拨老），以及 `since` 语义的端到端验证 ——
  那就是 P1-D3「看门狗每 30 分钟空转、日志却写『日记完成』」那条事故的判据。
- 既有 `tests/r05-diary-state.test.js` 只改了 import 路径与调用点，**断言一字未动**（已逐行核对）。

### 变更

- 契约快照走正规通道：`deliver.js` 新增 `askAgentToWrite` / `shouldAskAgain`，
  `agent.js` +`diaryAgent`，`scheduler.js` −2。理由已记入 `SNAPSHOT_CHANGES.md`
  （其中「R16 #26」是交付方的笔误，发布时更正为 R17）。
- **至此 `docs/KNOWN-ISSUES.md` 只剩 #23**（错误边界需宿主暴露 `React.Component`）。

---

## 0.9.11 · 2026-11-10

外部复检轮 **R16（重构轮）**，2 个提交 / 9 文件 / +583 −443。**对外行为零变化**：
88 测试 / 11 契约 / lint / bundle 零 diff 全绿；复核时逐个函数比对，**10 个函数体在新旧位置逐字一致**。

### 重构

- **`diary/compose.js`（644 行四职责）按职责切四块**（#27）：
  - `diary/llm.js` —— `describeFinishReason` / `summarizeConversations` / `composeDiaryText`（246 行）
  - `diary/history.js` —— `readRecentDiaries` / `digestDiaries`（84 行）
  - `diary/agent.js` —— `composeDiarySetup`（76 行，**移正到 HANDOFF 建议的位置**：它全是宿主服务交互，与拼 prompt 无关）
  - `diary/compose.js` —— 只剩 prompt 组装：`diaryWindowOf` / `buildMoodBlocks` / `composePublicMessage` / `composePrivateMessage`（217 行）
- 函数体由脚本按段落切分，**逐字未改**；事故注释随代码搬家；顺手删掉两段孤儿 docblock
  （`diaryAgent` 的注释，函数本体 2026-11-06 已迁 `scheduler.js`，注释被遗留在 compose.js）。
- `lib/diary.js` 门面导出名集合（29 个）前后**完全一致**，只是改由 `llm` / `history` / `compose` 三处分发。

### 测试

- 新增 `tests/r16-compose-feature.test.js`（11 断言），**先于拆分提交**且在旧代码上全绿。
  它补上了此前**零直接覆盖**的两个函数：`buildMoodBlocks` 与 `composeDiarySetup`
  （后者含 2026-11-05 那次事故修的行为：会话不活跃时从落盘日志回读 preset）。

### 变更

- 契约快照走正规通道：新增 `diary/agent.js`、`diary/history.js`、`diary/llm.js` 三个模块，
  `compose.js` 移出 5 个导出；理由已记入 `SNAPSHOT_CHANGES.md`。

---

## 0.9.10 · 2026-11-09

外部复检轮 **R15（重构轮）**，3 个提交 / 13 文件 / +451 −137。**对外行为零变化**，
四道门禁（lint / 87 测试 / 11 契约 / bundle 零 diff）全绿；特征测试先于拆分提交，拆分后一条未改。

### 重构

- **`segment-memory.js` 的 `text()` 拆分**（#28）：~150 行的编排降为 ~35 行调度 + 三个**文件私有**函数
  （`collectDiaryMaterial` / `memoryBudgetPlan` / `computeRecallText`）。无新增导出，契约零变化。
  分开的五条路径（首轮整卡 / 关召回老路 / 退化 query / 粘性复用 / 按句召回）与粘性读写位置逐个比对一致，
  所有事故注释随代码搬到对应函数。

### 修复

- **preview.html 的 CSS 已经漂移了**（#35）：手工抄的那份还停在 `.soul-legend`，`styles.js` 早已是
  `.soul-banner` —— 也就是说预览页一直是错的，只是没人比对过。现在同步 + 新增
  `tests/preview-css.test.js` 逐字符比对（塞一个空格就红）。
- **构建会静默吞掉未登记的片段**（#32）：`lib/client/` 下不在 `ORDER` 里的文件不报错、拼不进 bundle、
  页签一片空白。现在反向扫描，未登记直接构建失败并列出文件名；`DECL_RE` 同时放宽到 `let/const`
  （原来顶层 `let/const` 逃过跨片段重名检查）。

### 变更

- **`revOf` 三处逐字重复收敛到 `memory/constants.js`**（#33）：快照 `+revOf`，理由已入 `SNAPSHOT_CHANGES.md`。
- `summarizeConversations` 标注废弃（#34，主流程已不用，`tests/diary.test.js` 仍经门面在测）。
  **更正一处文档错误**：`askAgentToWrite` 的 `force` 参数**不是**死代码 ——
  `regenerateDiary` 确实传 `{ force: true }`，手动重写在用。

---

## 0.9.9 · 2026-11-09

外部复检轮 **R14**（按 `docs/HANDOFF.md` §8 只交付不发布），本会话逐条复核后合并发布。
4 文件 / +201 −25 / 1 个提交；四条修复**全部经毒化复核**确认「不修会红」。

### 修复

- **笔记页反复误报「已变更」**（#20）：`reconcile()` 的 `changed` 判据原来按**索引对位**比较，
  索引条目顺序一变（并发写索引、新建一篇 push 到尾部）每个对位都失配 → 恒 `changed=true` → 反复写盘。
  现在按 slug 建 Map 逐条比内容，顺序无关。
- **`readNote` 返回索引里的旧值**（#21）：文件被外部改写后，`loadIndex()` 给的 `chars/summary`
  与磁盘不符。现在统一走 `reconcile()`（与 `listNotes()` 同口径）。
- **长订单号/雪花 ID 被当卡号抹掉且不可恢复**（#15）：原来 `\b\d{16,19}\b` 见长数字就抹。
  现在改 **Luhn 校验 + 发卡前缀（3–6 开头）** 双判；不过 Luhn 但前文紧挨「卡号/银行卡/尾号」等
  上下文词的，仍兜底照抹。真卡号漏抹概率≈0（主流发卡组织强制 Luhn），随机长订单号命中率从 100% 降到约 1/25。
- **会话下拉的扫盘兜底每次全量扫**（#2）：服务不可用/无活会话时的兜底路径加 60 秒 TTL 缓存。
  代价是新会话最多晚一分钟出现在下拉里（低频低精度展示，可接受）。

### 变更

- `lib/memory/signals.js` 新增模块内私有 `luhnLike`、`CARD_CONTEXT_RE` —— **无新增导出**，契约快照不变。
- 文档更正：`KNOWN-ISSUES` 原把 #15 的位置写成 `lib/extract.js`，实现在 `lib/memory/signals.js`。

---

## 0.9.8 · 2026-11-08

本版是 **R13（外部复检轮）的合并 + 一处复核修复**。R13 有 5 个提交、26 文件、+628/−157，
来自基于 v0.9.7 的独立分支，本会话逐项复核后合并（说明见 `docs/KNOWN-ISSUES.md` 顶部）。

### 修复

- **日记列表预览把汉字切成半个**（R13 #1 的复核补丁）：`/diary/list` 改成只读头部 400 字节后，
  `400 % 3 ≠ 0` 让边界必然落在某个汉字中间，预览末尾出现 `�`（U+FFFD）。
  现在多读 3 字节再丢掉残缺尾字。附带补了带 REDGREEN 的断言 ——
  第一版测试因为前缀字节数恰好让边界落在字与字之间，**修没修都是绿的**，poison 复核时才发现。

### R13 合并进来的修复（23 条）

- **一致性**：#8 `maxRecords` 口径统一、#12 控制字符补 C1/U+2028-2029、#13 合并补 `decayed`、
  #14 `id` 哈希掺 scope、#16 `diaryWindowOf` 空窗、#18 布尔优先级、#19 digest 跳过模板块。
- **日志与请求层**：#9 `sanitizeLogText`、#10 `readBody` 413、#11 TOCTOU、#17 轮转撞名序号。
- **性能**：#1 只读头部、#3 备份免全量解析、#4 归档尾块读、#5 迁移退避、#6 mood key 全局化、#7 meta 缓存。
- **前端与架构**：#22 config 只发改动键、#24 后台暂停轮询、#25 预览受控渲染、
  #29 注释补 data-policy、#30 游标按 agent 分键、#31 缓存上限。

### 变更

- `env.js` 新增 `sanitizeLogText` 导出；`tools/lint.mjs` 仍零问题。
- 与 `d243fd7`（第三方许可声明）合并后，`lib/client.js` 里的原作者署名注释完整保留。
- **合并同期另一条改动**：日记对话流水改为按「工作区 → 会话 → 时间」分组（新增 `lib/core/session-groups.js`），
  同时开着的几个对话不再交错。这是一次**有意的输出变更**，`behavior-golden` 基线已按正规通道刷新
  （理由记为：分组 + R13 的 compose/feed 修复叠加）。

---

## 0.9.7 · 2026-11-07

### 文档

- 新增 [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md)：把**尚未修**的条目集中列出来（性能 7 条、一致性 14 条、前端 4 条、可维护性 10 条、明确不修 3 类、待确认 2 条），每条带代码位置、影响、建议改法与「验证程度」（A 实测 / B 读代码 / C 仅按报告归档）。
- 这一版**不改任何代码**，只是把「还剩什么」写清楚，避免下一轮凭记忆修。

---

## 0.9.6 · 2026-11-07

### 工程化

- **单个测试文件加超时**（P2-29）：`tools/run-tests.mjs` 原来没有超时，一个挂死的用例（未 settle 的 await）能把 CI 拖到 GitHub 的 6 小时上限。现在默认 180 秒、`--timeout=<秒>` 可覆盖，超时按失败计并点名。
- **CI 加 `timeout-minutes` 与 `concurrency`**（P2-30）：前者防止一次挂死烧光额度，后者让同一分支的旧 run 自动取消。
- **Linux job 跑 Node 22 + 24 矩阵**：`engines` 要求 ≥22.19，而 24 是当前主力版本，之前从没在 24 上跑过 CI。
- **新增 `npm run lint`（`tools/lint.mjs`）**：不引入 eslint（本项目零依赖），只查两条真出过问题的：未使用的 import、以及测试里的恒真断言 `ok(true, …)`。
- **清掉 9 处恒真断言**：`ok(true, '临时目录已清理')` 这类直接删除（清理动作仍在，只是不再假报一条绿）；`r1-maintain-persist` 那条「没产生归档就跳过」改成**前置条件失败即红**；`smoke` 的 `disposer 可调用` 改成真断言「调用没抛错」。
- **修掉 1 处未使用导入**：`core/api-token.js` 的 `serviceOf`。

---

## 0.9.5 · 2026-11-07

### 修复

- **清理对话记录可能早删一天**（P2-20）：`dateKeyOf` 用的是 UTC，而引擎其它所有日期键都是本地时间。东八区晚上 8 点后本地已是第二天、UTC 还是当天 —— 清理时算错「今天」，把还该留的那天删掉。现在统一本地口径。
- **项目卡损坏在设置页看不见**（P2-21）：`memoryHealth` 原来只查全局卡。现在把全局卡与所有项目卡一起汇总（含已被改名的 `.corrupt-*`），并指出是哪一张。
- **`soul_diary` 正文没有字数上限**（P2-32）：一次写几万字会持续撑爆每轮注入预算。现在与 `notes` 同量级卡在 20000 字，并明确告诉她原因。
- **看门狗间隔改配置不生效**（P2-22）：原来启动时读一次就固定。现在 1 分钟滴答、每次现读配置。
- **维护失败当天不再重试**（P2-24）：`dailyHour` 模式下 `maintainClock.day` 原来在维护**执行前**就置位，抛错当天就再也不跑。现在置位挪到成功之后。
- **日记启动流程双层预算嵌套**（P2-23）：两次 `runDiaryOnce` 原来各吃满 12 分钟，追补最长 ~24 分钟；现在共用一份预算。
- **「错误边界」其实不是错误边界**（P2-27）：它只监听 `window.error`，接不住未处理的 Promise 拒绝（而设置页最多的就是 fetch 失败）。现在补上 `unhandledrejection`。**渲染期抛错仍会白屏** —— 真正的 React 边界需要 `Component` 基类，这段 bundle 的作用域里没有，不假装已解决。

---

## 0.9.4 · 2026-11-07

### 安全

- **限流在反代下退化成全局单桶**（P2-16）：原来只按 `remoteAddress` 分桶，反代后面所有人的来源都是代理地址 —— 一个远程用户把 `/session` 桶打空就能锁死所有人的设置页。现在持有效令牌的请求按**令牌摘要**分桶，无令牌的仍按来源 IP。
- **新增 `DSH_SOUL_TRUSTED_PROXY=1`**（反代来源折中）：开启后限流分桶与日志用 `X-Forwarded-For` / `X-Real-IP` 里的真实来源。**只影响日志与分桶，不参与任何授权判定** —— 这两个头客户端可伪造，配错最坏是限流变松，不会提权。
- **会话令牌 24 小时自动轮换**（P2-15）：原来令牌永不变化，泄露后只能重启。现在到期自动换（前端 401 后自己重新取，用户无感）；另加 `POST /session/rotate` 手动作废（要带当前令牌）。
- **prompt-guard 的混合宽度与零宽字符绕过**（P2-17）：`<`…`＞`、`＜`…`>` 这类混搭、以及 `</untr\u200Busted_data>` 这种零宽插入，原来都不中和。现在先清零宽字符，再按混合宽度规则中和。
- **echo 段切在闭合标签中间**（P2-18）：原来先包边界再 `slice` 截断，超预算时会切掉闭合标签；改成先裁正文再包。

### 变更

- 新增环境变量 `DSH_SOUL_TRUSTED_PROXY`（见 README「反向代理部署」）。
- 新增路由 `POST /session/rotate`。

---

## 0.9.3 · 2026-11-07

### 性能

这一批**不改变任何对外行为**，只是少做无用功。

- **第 201 个会话会让其余会话集体失忆**（P2-10）：8 处 `if (map.size > N) map.clear()` 改成 `trimMap(map, N)`（只淘汰最旧的）。原来清空意味着重注人格、去重表失效、游标从头重扫全量事件。
- **日志每行 4 次系统调用**（P2-1）：`mkdirSync` / `chmodSync` 改成每个文件只做一次（Windows 上 chmod 原来每行抛一次异常再吞掉）。目录被删、权限变化时会在同一次调用里自愈并重试一次。
- **`snapshotEvents()` 无参全量拷贝**（P2-2）：`turnKeyOf` / `hasHumanInputThisTurn` 改成只取尾部 400 条；窗口里没有 assistant 消息（超长工具轮）时**自动退回全量**，不拿正确性换性能。
- **`readRecentChat` 每次全量 parse 当天 JSONL**（P2-5）：按 `(size, mtimeMs)` 缓存，文件一被追加就失效 —— 不需要 TTL 计时器。
- **`purpose.json` 每回合写盘**（P2-8）：drives 是 0~1 的对象，任一维变化 > 0.01 或距上次写盘超 10 分钟才落盘（时间漂移导致的缓慢变化也会定期持久化）。

### 新增

- `lib/core/lru.js`：`trimMap` / `touchMap`。

---

## 0.9.2 · 2026-11-07

### 修复

- **合并路径会把主记忆文件挪走**（P2-12，数据安全级）：`saveCardMerged` 在合并前调 `loadCard`，而它的 catch 会 `parkCorrupt` —— 一次瞬时读失败就把主卡改名 + 置只读，随后写盘往空路径写新卡。新增无副作用读 `readCardQuietly`，合并与写后回读都改用它；`loadCard` 只留给真正的加载路径。
- **鉴权链没有任何兜底**：Origin / Host / 回环 / 令牌四段校验原先裸奔在 handler 体里，任何一段将来抛错都会逃出 `webServer` → 未捕获 → **宿主进程退出**。现在整段包一层 catch，异常记日志 + 回 500 + 追踪码。
- **自定义 judge provider 静默失败**（P2-19）：`judgeProvider` 配成非 siliconflow 时会把 provider 原样交给宿主，宿主不认识就每轮判定失败、只留一行日志，表现为「她情绪一直不变」。现在第一次调用就明确告警。
- **设置页改配置会丢**（P2-25/26）：三个 Tab 原来都 POST **全量**配置，跨 Tab 保存互相覆盖；文本输入框还是逐键 POST。现在各 Tab 只发改动键（服务端本就按 key 合并），并加 300ms 防抖。
- **记忆搜索逐键重取**（P2-28）：带 query 时 300ms 防抖。
- **日记「文件存在但不完整」死循环**：`startupWork` 判定要重写，但 `askAgentToWrite` 只要看到文件存在就认为「她写好了」，于是每轮空转、日志写「日记完成」，内容永远补不回来。现在「要不要再找她写」多了时间基线（`shouldAskAgain`）。
- **兜底覆盖她迟到写出的日记**：`waitForWrite` 超时后插件兜底写盘，会盖掉她几秒后落盘的那篇。`writeDiaryFile` 增加 `skipIfNewerThan`，比她旧才写。
- **`lastTalkAtOf` 只扫末 80 行**：文件本就整份读进内存，只遍历尾部纯属遗留写法；多会话交错时最后一句会被挤出窗口，导致「半天版」被判完整。
- **固定区（pinned / initial）无上限**：固定区有独立预算（`injectMaxChars × 2`），2 倍以内宁可超出也完整保留，超过才裁并明说「还有 N 条这轮没放下」。
- **游标在 `snapshotEvents` 抛错时不推进**：现在一定推进，且整卡注入只宽限一次。
- **`mountedOffs` 强引用**：改存 `WeakRef`，会话关闭后 agent 可被回收。
- **喂给 `drives` 的素材顺序**：由「数组尾部 12 条」改为按 `lastSeenAt`（最近被想起）优先排序。
- **跨进程写卡竞态**：写后回读 `rev`，发现被别人覆盖时记日志（**只检测，不自动重写**）。

### 变更

- `lib/state/maintain.js` 新增 `pickRecentMaterials`（纯函数，可单独测）。
- `lib/memory/card-io.js` 新增 `readCardQuietly`（无副作用读卡）。
- 客户端新增 `apiPostDebounced`（按 key 防抖的 POST）。

---

## 0.9.1 · 2026-11-07

### 修复（安全）

- **反代部署下 `/api/soul/*` 全量 403**（[#1](https://github.com/danshuyue/dsh-agent-soul/issues/1)）：
  Host 判定改为**以宿主为准** —— 先问 `ctx.connection.requestRejection(req)`，
  `null` 放行、`401`（宿主侧未登录）放行到插件自己的 `x-soul-token` 校验、`403` 才拒；
  宿主不可用 / 抛错时退回插件白名单。原来插件自维护信任名单，与宿主 `--trusted-host` 两套 fence 打架。
- **任意文件读取**（`GET /state?cwd=<任意目录>` 可读该目录 `AGENT.md` 前 400 字）：
  cwd 归属校验收口，`GET /persona` 一并补上。
- **`GET /persona` 绕过 cwd 归属校验**且返回全文。
- **UNC / 设备路径**（`\\host\share`、`\\.\`、`\\?\`）：`statSync` 会发起 SMB 连接并携带 NTLM 凭据，且同步阻塞事件循环。现在字符串阶段直接拒，`statSync` 挪到归属判定之后。
- **`sec-fetch-site` 值拼错**（`'samesite'` ≠ `'same-site'`），同站防线此前从未生效。
- **错误原文回显**：`/pick`、`/persona` 保存、`/open` 三处不再把含绝对路径的 `error.message` 回给客户端，改为固定文案 + 追踪码。
- **数据边界可伪造**：`<user_data>` 换成带内容哈希 nonce 的 `<untrusted_data>`，内容拼不出真闭合标签；人格段补 `PERSONA_GUARD` 声明。
- **配置数值无上限**：新增 `NUMBER_RANGES` 覆盖 35 个数值键，越界拒绝（此前 `diaryAgentTimeoutMs = 1e12` 也能存）。
- **日记主流程无总超时**：12 分钟总预算 + 超时后 orphan 防重入。
- **`/register` 反向放行归属校验**：新增写侧唯一入口 `resolvePostCwd`。
- **PowerShell 回退链是断的**（裸名字分支直接 return，第三级永远不可达）；顺带校验 DPAPI 输出，避免存下解不开的空密文。
- **`POST /memory` 的 `edit` 分支绕过脱敏**。
- **`maintain` 无视 `projectMemoryEnabled`**。
- **记忆卡容量到顶且无可压缩项时仍 `push`**。
- **Origin/Host 端口比较**：`String(host).split(':')[1]` 对无端口的 Host 与 `[::1]:8080` 都恒不相等；改为规范化权威比较，两端同为回环时允许端口不同。

### 变更

- 新增一次性提示：接口被非本机 Host 访问时在日志里提醒（只记一次）。

### 破坏性

- **`POST /register` 不再接受任意路径**：只接受「已登记 / 宿主会话给的 / `DSH_HOME` 内」。设置页「把路径粘到输入框」这条路关闭，请改用「选择文件夹」。
- **`POST /config` 数值越界返回 400**（此前静默接受）。
- `DSH_SOUL_POWERSHELL` 指向不存在的路径时保存密钥直接失败，不再静默回退。

---

## 0.9.0 · 2026-11-06

### 变更

- **模块化重构**：`lib/` 拆成 95 个模块（`host/runtime`、`memory/`、`state/`、`diary/`、`http/`、`core/`）。
- 新增契约门禁三件套：导出快照、行为 golden、依赖图；刷基线必须写明理由并留痕。

### 破坏性

- **新增 Host 白名单**（见 `0.8.3`）：`/api/soul/*` 只接受 `localhost` / `127.0.0.1` / `[::1]` / `::1`
  以及 `DSH_SOUL_ALLOWED_HOSTS` 里的值。**反向代理 + 公网域名/IP 的部署会整页 403** ——
  这就是 `0.9.1` 修的那条（[#1](https://github.com/danshuyue/dsh-agent-soul/issues/1)）。
  当时没有写进任何变更说明，是本项目的流程失误。

---

## 0.8.3 · 2026-11-06

### 变更

- 加固（R2/R3/R4）：**Host 白名单**、`localNames` 只认纯文件名、回环门控下沉。

> **注意**：`DSH_SOUL_ALLOWED_HOSTS` 是 `DSH_` 前缀的启动期变量，**只能**通过
> `systemd Environment=` / `docker -e` / shell `export` 设置。写进 `.env` 会让 dsh 直接启动失败。

---

## 0.8.0 – 0.8.2 · 2026-11-05 / 11-06

无变更记录（本文件从 `0.9.2` 起才存在）。这几个版本没有 Host 白名单。
