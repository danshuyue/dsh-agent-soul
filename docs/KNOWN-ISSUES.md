# 已知问题清单（截至 0.9.11；R13 划 23 条、R14 划 4 条、R15 划 5 条、R16 划 1 条）

> 2026-11-08 R13 轮：~~划线~~ 条目已修，测试锚定在 `tests/r13-batch.test.js`（36 断言），
> 修法见提交历史（fix/known-issues-r13 分支 R13 批次一～五）。
>
> **2026-11-09 R14 轮（0.9.9）**：又划掉 **#2 #15 #20 #21** 四条，测试锚定在
> `tests/r14-notes-redact-sessions.test.js`（13 断言），四条均经发布方毒化复核为红。
>
> **2026-11-09 R15 轮（0.9.10，重构）**：划掉 **#28 #32 #33 #34 #35**。
> #28 的 `text()` 拆成三个文件私有函数（无新导出，契约只多了 #33 的 `revOf`）；
> 特征测试 `tests/r15-segment-feature.test.js`（13 断言）**先于拆分提交**，拆分后一条不改全绿。
> #35 是**真问题**：preview 的 CSS 确实已经漂移到旧类名，现在是逐字符比对的硬门禁。
>
> **2026-11-10 R16 轮（0.9.11，重构）**：划掉 **#27**。`compose.js`（644 行）按职责切四块：
> `llm.js` / `history.js` / `agent.js`（`composeDiarySetup` 移正）/ `compose.js` 只留 prompt 组装。
> 特征测试 `tests/r16-compose-feature.test.js`（11 断言）先于拆分提交；复核时逐个函数比对，
> **10 个函数体在新旧位置逐字一致**，门面导出 29 个名字前后完全相同。
> **仍打开：#26（最后一个大文件）、#23（等宿主暴露 React.Component）与第五、六节。**
>
> **2026-11-08 复核补丁（0.9.8）**：R13 的 #1（`/diary/list` 只读头部 400 字节）按字节切 UTF-8，
> 中文预览末尾会出现 `�`（U+FFFD）—— 400 % 3 ≠ 0，边界必然落在汉字中间。
> 已改为「多读 3 字节 + 丢掉残缺尾字」，并在 `tests/r13-batch.test.js` 补了带 REDGREEN 的断言。
> 记一笔当时的教训：第一版测试用「【公开】+ 日期」前缀（25 字节），375 恰好整除 3，
> 边界落在字与字之间 —— **修没修都是绿的**，poison 复核时才发现这是假绿。

> 这份清单是**给下一轮修**用的，不是发布说明。所有条目都已复核过代码位置；
> 每条都标了「验证程度」，方便判断可信度：
> **A = 读代码 + 实测复现过**，**B = 读代码确认**，**C = 只按报告描述归档，未逐行核**。
>
> 状态：`0.9.1`–`0.9.6` 清掉全部 14 条 P1 与大部分 P2；R13 清 23 条、R14 清 4 条。
> 下面剩下的**没有一条会立刻让插件罢工**，但每一条都会在特定条件下让人踩到。

---

## 一、性能（数据量大才显形）

| # | 问题 | 位置 | 影响 | 建议 | 验证 |
|---|---|---|---|---|---|
| ~~1~~ ✅已修(2026-11-08 R13) | `/diary/list` 循环 30 天**全量**读日记，只取前 400 字 | `lib/http/routes/diary.js` | 每天 2 次请求，30 天 × 全量读 → 打开日记标签页要等一下 | 读前 400 字节（`readFileSync` 带 `length`），或按需懒加载 | B |
| ~~2~~ ✅已修(2026-11-09 R14) | `/diary/sessions` 两层 `readdir` + 逐目录 `stat` 兜底 | `lib/http/sessions.js` | 会话目录多时列表慢 | 加 TTL 缓存 + `withFileTypes` 一次拿全 | B |
| ~~3~~ ✅已修(2026-11-08 R13) | `saveCard` 每次写盘前**完整解析旧文件**（只为判断能否备份）+ `copyFileSync` | `lib/memory/card-io.js` | 记忆写入路径多一次全量解析 | 本进程写过的可跳过解析；备份改硬链接/懒备份 | B |
| ~~4~~ ✅已修(2026-11-08 R13) | `recallArchived` 读**全部**归档分片再截 tail | `lib/memory/card-io.js` | 归档攒多之后查历史慢 | 旧分片只读尾块 | B |
| ~~5~~ ✅已修(2026-11-08 R13) | v1→v2 迁移失败时，每次 `loadCard` 都重试写盘 + 刷日志（且改写 mtime 使缓存 stamp 永远失配） | `lib/memory/card-io.js` | 一张老卡能刷满日志、并让缓存失效 | 迁移失败加退避 + `note` 节流；别在读取路径写盘 | B |
| ~~6~~ ✅已修(2026-11-08 R13) | `moodPath` 已是全局单文件，但缓存 key 按 `cwd` 分裂；写失败 settle 只救一个 key | `lib/paths.js` + `lib/state/mood-state.js` | 双工作区下偶发「旧值覆盖新值」 | key 固定成 `mood:global` | B |
| ~~7~~ ✅已修(2026-11-08 R13) | `readSessionMeta` 无缓存，每次全量解压 ≤16MB 日志 | `lib/session-title.js` | 标题/元信息路径反复解压 | 复用 `readTitleFromLog` 的 `(size, mtime)` 缓存 | B |

> 已修（供对照）：日志每行 4 次系统调用（P2-1）、`snapshotEvents()` 全量拷贝（P2-2）、
> `readRecentChat` 全量 parse（P2-5）、`purpose.json` 每回合写盘（P2-8）、8 处 `clear()`（P2-10）。

---

## 二、一致性与小缺陷

| # | 问题 | 位置 | 影响 | 建议 | 验证 |
|---|---|---|---|---|---|
| ~~8~~ ✅已修(2026-11-08 R13) | `maxRecords` 两处夹取值不一致：`normalizeConfig` 夹 `[20, 5000]`，`NUMBER_RANGES` 卡 `[50, 3000]` | `lib/memory/config.js` vs `lib/http/middleware.js` | 手改配置文件能跳过 `/config` 的校验 | 两边统一（建议都 `[20, 5000]`） | A |
| ~~9~~ ✅已修(2026-11-08 R13) | `note()` 日志注入：来自请求体的值未清洗就进日志 | `lib/http/routes/memory.js`、`routes/diary.js` | 恶意/意外换行能把一条日志拆成几条 | 统一 `sanitizeLogText()`（去控制字符 + 截断） | B |
| ~~10~~ ✅已修(2026-11-08 R13) | `readBody` 超限时回 **500** 而不是 413，且 `destroy()` 之后仍写响应 | `lib/http/middleware.js` | 客户端看不出「请求体太大」，只看到服务器错误 | 改 413 + 先判断 `writableEnded` | B |
| ~~11~~ ✅已修(2026-11-08 R13) | `/diary/list` 的 `exists → statSync` 是 TOCTOU | `lib/http/routes/diary.js` | 并发删文件时偶发 500 | 直接 `statSync` 并 catch | B |
| ~~12~~ ✅已修(2026-11-08 R13) | `validateConfigEntry` 的控制字符黑名单漏 C1 区（`\u0080-\u009F`）与 `U+2028/2029` | `lib/http/middleware.js` | 某些行分隔符能进配置值 | 改用 `/\p{Cc}\|[\u2028\u2029]/u` | B |
| ~~13~~ ✅已修(2026-11-08 R13) | `mergeCards` 合并 `stats` 时漏了 `decayed` 字段 | `lib/memory/card.js` | 跨进程合并后衰减计数丢失 | 补字段 | B |
| ~~14~~ ✅已修(2026-11-08 R13) | `normalizeRecord` 补 id 的哈希不掺 `scope` | `lib/memory/card.js` | 跨卡「同文本 + 同时间」会撞 id，被误并成一条 | 哈希里加 scope | B |
| ~~15~~ ✅已修(2026-11-09 R14) | `redact` 的银行卡正则 `\b\d{16,19}\b` 误伤长订单号/雪花 ID，且不可恢复 | `lib/memory/signals.js`（原写 extract.js，实现在这里） | 正常内容被抹成 `[卡号]` | 改 Luhn + 发卡前缀（3–6）+ 上下文词兜底 | B |
| ~~16~~ ✅已修(2026-11-08 R13) | `diaryWindowOf` 对 NaN 月/日静默回退成 1 月窗口 | `lib/diary/compose.js` | 坏日期会读错时间段 | 显式判 NaN 并返回空窗口 | B |
| ~~17~~ ✅已修(2026-11-08 R13) | 日志轮转归档名精确到**分钟**，同分钟二次轮转覆盖/失败 | `lib/env.js` | 极端情况下丢一份归档 | 归档名加序号或毫秒 | B |
| ~~18~~ ✅已修(2026-11-08 R13) | `diary-pick.js` 的布尔优先级可疑（`&&` 先于 `\|\|`） | `lib/core/diary-pick.js` | 选会话的条件可能和注释不符 | 加括号 + 补测试 | C |
| ~~19~~ ✅已修(2026-11-08 R13) | mood digest 把 `decay` 模板句收进「那天你自己的想法」候选 | `lib/mood/digest.js` | 日记里出现系统模板句 | 跳过 `kind === 'decay'` | B |
| ~~20~~ ✅已修(2026-11-09 R14) | `notes reconcile` 按**索引**对位比较，顺序一变就误报 `changed` | `lib/notes.js` | 笔记索引反复刷新 | 改按 slug 建 Map 比较 | B |
| ~~21~~ ✅已修(2026-11-09 R14) | `readNote` 用 `loadIndex` 而不是 `reconcile` | `lib/notes.js` | 可能返回已删文件的条目 | 统一走 reconcile | B |

---

## 三、前端

| # | 问题 | 位置 | 影响 | 建议 | 验证 |
|---|---|---|---|---|---|
| ~~22~~ ✅已修(2026-11-08 R13) | 各 Tab 各持 stale config 快照（跨 Tab 保存会覆盖） | `lib/client/*-tab.js` | 已用「只发改动键」缓解 90%，但架构上仍是旧快照 | 把 config 状态提升到 `SoulSection` 单点持有 | A |
| 23 | 「错误边界」接不住**渲染期**异常 | `lib/client/app.js` | 某次渲染抛错 → 白屏 | 需要 `React.Component` 基类；本 bundle 作用域里没有，**做不了，只能等宿主暴露** | A |
| ~~24~~ ✅已修(2026-11-08 R13) | mood 页在后台标签页仍按 20s 轮询 | `lib/client/mood-tab.js` | 后台也耗电/耗请求 | `document.visibilityState` 时暂停 | B |
| ~~25~~ ✅已修(2026-11-08 R13) | diary 页的公开预览用 `getElementById` 直写 DOM，绕过 React | `lib/client/diary-tab.js` | 与 React 状态不一致 | 改回受控渲染 | B |

---

## 四、架构 / 可维护性（P3 摘要，本轮刻意不动）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 26 | `diary/scheduler.js` 687 行混五种职责 | 改一处要读整文件 | 拆 `diary/agent.js` + `diary/deliver.js` |
| ~~27~~ ✅已修(2026-11-10 R16) | `diary/compose.js` 644 行四类职责，`composeDiarySetup` 放错位置 | 同上 | 已切四块：`llm.js`（LLM 调用）/ `history.js`（最近日记）/ `agent.js`（`composeDiarySetup` 移正）/ `compose.js` 只留 prompt 组装（217 行）；10 个函数体逐字未改 |
| ~~28~~ ✅已修(2026-11-08 R15) | `host/runtime/segment-memory.js` 的 `text()` 约 150 行、8 种职责的上帝函数 | 难以单测 | 拆 `collectDiaryMaterial` / `memoryBudgetPlan` / `computeRecallText`（均文件私有，无新导出） |
| ~~29~~ ✅已修(2026-11-08 R13) | `index.js` 顶部注释的注入顺序漏了 `soul:data-policy` | 文档与代码漂移 | 补一句 |
| ~~30~~ ✅已修(2026-11-08 R13) | `extract` 游标对「无 id 会话」统一用 `'default'` 键 | 两个会话互吃扫描窗口 | 用会话对象身份做键 |
| ~~31~~ ✅已修(2026-11-08 R13) | `TITLE_CACHE` / `PATH_CACHE` 全仓库唯一无上限缓存 | 长跑内存缓慢增长 | 用 `trimMap` 限一下 |
| ~~32~~ ✅已修(2026-11-08 R15) | `build-client.mjs` 的 `ORDER` 硬编码；符号扫描 `DECL_RE` 只认 4 空格的 `var/function` | 新增片段漏登记会静默丢失；`let/const` 逃检 | 构建反向扫描 + 未登记即失败；`DECL_RE` 放宽到 `let/const` |
| ~~33~~ ✅已修(2026-11-08 R15) | `revOf` 三处逐字重复（`card.js`/`card-io.js`/`state/cards.js`） | 改一处要改 N 处 | 收敛到 `memory/constants.js` 单份导出（快照 +revOf，已入档） |
| ~~34~~ ✅已处理(2026-11-08 R15) | `summarizeConversations` 主流程已不用 | 误导读者 | docblock 标注 ⚠️ 废弃（测试迁移后连门面导出一起删）。**更正**：`force` 参数**不是**死代码 —— `regenerateDiary` 传 `{ force: true }`，手动重写在用 |
| ~~35~~ ✅已修(2026-11-08 R15) | `docs/preview.html` 手工复制 `styles.js` 整套 CSS | 改样式后预览过期 | 已实测漂移（`.soul-legend` vs `.soul-banner`）；同步 + 新增 `tests/preview-css.test.js` 逐字符比对 |

---

## 五、明确「不修」的（已权衡）

| 项 | 为什么不修 |
|---|---|
| 反代下 `isLoopbackRequest()` 恒真 | 代理把 `remoteAddress` 变成 `127.0.0.1`，插件侧没有可靠信号区分真实远端。引入 `DSH_SOUL_TRUSTED_PROXY` 做**授权**判定会把权限建立在可伪造的请求头上 —— 已开的那个变量**只用于分桶与日志**。真正的锁是 `x-soul-token` + 上游鉴权。 |
| 跨进程写卡「不自动重写」 | 写后检测 + 告警已够用；自动重写要给**每一次**写盘加成本，而多进程并发是低频场景。 |
| `P3` 大部分条目 | 改了不解决任何用户问题，却要碰 40 个文件。等前几类清完、测试稳定后再单独一轮。 |

---

## 六、两条待确认（依赖宿主行为，仓库内无法验证）

| 项 | 不确定的是什么 | 现在怎么兜 |
|---|---|---|
| 压缩会话的 `snapshotEvents(0, seq+1)` 会不会抛 | 宿主是打包的 `.asar`，造不出真实压缩会话 | 抛了也不推进锁：游标一定推进、整卡注入只宽限一次（第一次失败仍注入，之后不再重复）。**若有人报「新会话没人格」，先看这里。** |
| 反代 + 非默认端口下 `Origin`/`Host` 的边界形态 | 已按规范化权威比较、两端回环允许不同端口，但没有真实反代环境压测 | 被拒时 403 响应体带 `origin`/`host`，可直接对照 |

---

## 七、建议的下一轮顺序（0.9.11 后更新）

**只剩一条重构 + 一条受宿主限制的。**

1. **#26 `diary/scheduler.js`（687 行五职责）** —— 拆 `diary/deliver.js`（投递 / 超时 / 等待她写）
   + 会话相关部分并进 `diary/agent.js`（R16 已经把 `composeDiarySetup` 放在那儿了）。
   这是最后一条大文件。
2. **#23（渲染期白屏）** —— 除非宿主文档明确暴露了 `React.Component`，否则不要动。

重构纪律（R15/R16 两轮验证有效，照抄）：

- **先补特征测试**，单独一个提交，且要在**拆分之前**就在旧代码上全绿 —— 否则它可能断言的是实现；
- 拆分用**脚本按段落切分**（R16 的做法），别手抄 —— 手抄一定会在某处少一个空格或漏一行；
- 拆完特征测试**一条不改**必须全绿；
- **毒化一次**证明测试网有效。毒化不红时先怀疑毒化点或毒化写法：
  R15 第一版选了确定性路径（重算字节相同 → 不红），R16 第一版把条件写成 `A || B && false`
  （运算符优先级让毒化失效）—— **两次都是毒化写错，不是测试无效**；
- 复核方会**逐个函数比对**「函数体在新旧位置是否逐字一致」，这是纯移动的唯一硬证据。

> 这一轮之后，**功能类与清理类已知问题全部清零，只剩最后一个大文件**。
> 风险已经从「用户会踩到」变成「改的人会踩到」。

---

*清单随代码演进维护；修掉一条就把那条划掉并写进 `CHANGELOG.md`。*
