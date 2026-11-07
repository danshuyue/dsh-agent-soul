# 已知问题清单（截至 0.9.6）

> 这份清单是**给下一轮修**用的，不是发布说明。所有条目都已复核过代码位置；
> 每条都标了「验证程度」，方便判断可信度：
> **A = 读代码 + 实测复现过**，**B = 读代码确认**，**C = 只按报告描述归档，未逐行核**。
>
> 状态：`0.9.1`–`0.9.6` 清掉了全部 14 条 P1 与大部分 P2。下面剩下的**没有一条会立刻让插件罢工**，
> 但每一条都会在特定条件下让人踩到。

---

## 一、性能（数据量大才显形）

| # | 问题 | 位置 | 影响 | 建议 | 验证 |
|---|---|---|---|---|---|
| 1 | `/diary/list` 循环 30 天**全量**读日记，只取前 400 字 | `lib/http/routes/diary.js` | 每天 2 次请求，30 天 × 全量读 → 打开日记标签页要等一下 | 读前 400 字节（`readFileSync` 带 `length`），或按需懒加载 | B |
| 2 | `/diary/sessions` 两层 `readdir` + 逐目录 `stat` 兜底 | `lib/http/sessions.js` | 会话目录多时列表慢 | 加 TTL 缓存 + `withFileTypes` 一次拿全 | B |
| 3 | `saveCard` 每次写盘前**完整解析旧文件**（只为判断能否备份）+ `copyFileSync` | `lib/memory/card-io.js` | 记忆写入路径多一次全量解析 | 本进程写过的可跳过解析；备份改硬链接/懒备份 | B |
| 4 | `recallArchived` 读**全部**归档分片再截 tail | `lib/memory/card-io.js` | 归档攒多之后查历史慢 | 旧分片只读尾块 | B |
| 5 | v1→v2 迁移失败时，每次 `loadCard` 都重试写盘 + 刷日志（且改写 mtime 使缓存 stamp 永远失配） | `lib/memory/card-io.js` | 一张老卡能刷满日志、并让缓存失效 | 迁移失败加退避 + `note` 节流；别在读取路径写盘 | B |
| 6 | `moodPath` 已是全局单文件，但缓存 key 按 `cwd` 分裂；写失败 settle 只救一个 key | `lib/paths.js` + `lib/state/mood-state.js` | 双工作区下偶发「旧值覆盖新值」 | key 固定成 `mood:global` | B |
| 7 | `readSessionMeta` 无缓存，每次全量解压 ≤16MB 日志 | `lib/session-title.js` | 标题/元信息路径反复解压 | 复用 `readTitleFromLog` 的 `(size, mtime)` 缓存 | B |

> 已修（供对照）：日志每行 4 次系统调用（P2-1）、`snapshotEvents()` 全量拷贝（P2-2）、
> `readRecentChat` 全量 parse（P2-5）、`purpose.json` 每回合写盘（P2-8）、8 处 `clear()`（P2-10）。

---

## 二、一致性与小缺陷

| # | 问题 | 位置 | 影响 | 建议 | 验证 |
|---|---|---|---|---|---|
| 8 | `maxRecords` 两处夹取值不一致：`normalizeConfig` 夹 `[20, 5000]`，`NUMBER_RANGES` 卡 `[50, 3000]` | `lib/memory/config.js` vs `lib/http/middleware.js` | 手改配置文件能跳过 `/config` 的校验 | 两边统一（建议都 `[20, 5000]`） | A |
| 9 | `note()` 日志注入：来自请求体的值未清洗就进日志 | `lib/http/routes/memory.js`、`routes/diary.js` | 恶意/意外换行能把一条日志拆成几条 | 统一 `sanitizeLogText()`（去控制字符 + 截断） | B |
| 10 | `readBody` 超限时回 **500** 而不是 413，且 `destroy()` 之后仍写响应 | `lib/http/middleware.js` | 客户端看不出「请求体太大」，只看到服务器错误 | 改 413 + 先判断 `writableEnded` | B |
| 11 | `/diary/list` 的 `exists → statSync` 是 TOCTOU | `lib/http/routes/diary.js` | 并发删文件时偶发 500 | 直接 `statSync` 并 catch | B |
| 12 | `validateConfigEntry` 的控制字符黑名单漏 C1 区（`\u0080-\u009F`）与 `U+2028/2029` | `lib/http/middleware.js` | 某些行分隔符能进配置值 | 改用 `/\p{Cc}\|[\u2028\u2029]/u` | B |
| 13 | `mergeCards` 合并 `stats` 时漏了 `decayed` 字段 | `lib/memory/card.js` | 跨进程合并后衰减计数丢失 | 补字段 | B |
| 14 | `normalizeRecord` 补 id 的哈希不掺 `scope` | `lib/memory/card.js` | 跨卡「同文本 + 同时间」会撞 id，被误并成一条 | 哈希里加 scope | B |
| 15 | `redact` 的银行卡正则 `\b\d{16,19}\b` 误伤长订单号/雪花 ID，且不可恢复 | `lib/extract.js` | 正常内容被抹成 `[卡号]` | 加前缀白名单（62/4/5 开头）或按 Luhn 校验 | B |
| 16 | `diaryWindowOf` 对 NaN 月/日静默回退成 1 月窗口 | `lib/diary/compose.js` | 坏日期会读错时间段 | 显式判 NaN 并返回空窗口 | B |
| 17 | 日志轮转归档名精确到**分钟**，同分钟二次轮转覆盖/失败 | `lib/env.js` | 极端情况下丢一份归档 | 归档名加序号或毫秒 | B |
| 18 | `diary-pick.js` 的布尔优先级可疑（`&&` 先于 `\|\|`） | `lib/core/diary-pick.js` | 选会话的条件可能和注释不符 | 加括号 + 补测试 | C |
| 19 | mood digest 把 `decay` 模板句收进「那天你自己的想法」候选 | `lib/mood/digest.js` | 日记里出现系统模板句 | 跳过 `kind === 'decay'` | B |
| 20 | `notes reconcile` 按**索引**对位比较，顺序一变就误报 `changed` | `lib/notes.js` | 笔记索引反复刷新 | 改按 slug 建 Map 比较 | B |
| 21 | `readNote` 用 `loadIndex` 而不是 `reconcile` | `lib/notes.js` | 可能返回已删文件的条目 | 统一走 reconcile | B |

---

## 三、前端

| # | 问题 | 位置 | 影响 | 建议 | 验证 |
|---|---|---|---|---|---|
| 22 | 各 Tab 各持 stale config 快照（跨 Tab 保存会覆盖） | `lib/client/*-tab.js` | 已用「只发改动键」缓解 90%，但架构上仍是旧快照 | 把 config 状态提升到 `SoulSection` 单点持有 | A |
| 23 | 「错误边界」接不住**渲染期**异常 | `lib/client/app.js` | 某次渲染抛错 → 白屏 | 需要 `React.Component` 基类；本 bundle 作用域里没有，**做不了，只能等宿主暴露** | A |
| 24 | mood 页在后台标签页仍按 20s 轮询 | `lib/client/mood-tab.js` | 后台也耗电/耗请求 | `document.visibilityState` 时暂停 | B |
| 25 | diary 页的公开预览用 `getElementById` 直写 DOM，绕过 React | `lib/client/diary-tab.js` | 与 React 状态不一致 | 改回受控渲染 | B |

---

## 四、架构 / 可维护性（P3 摘要，本轮刻意不动）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 26 | `diary/scheduler.js` 687 行混五种职责 | 改一处要读整文件 | 拆 `diary/agent.js` + `diary/deliver.js` |
| 27 | `diary/compose.js` 591 行四类职责，`composeDiarySetup` 放错位置 | 同上 | 移到 `scheduler` 或 `diary/agent.js` |
| 28 | `host/runtime/segment-memory.js` 的 `text()` 约 150 行、8 种职责的上帝函数 | 难以单测 | 拆 `runToneForTurn` / `collectDiaryMaterial` / `computeRecallText` / `applyBudget` |
| 29 | `index.js` 顶部注释的注入顺序漏了 `soul:data-policy` | 文档与代码漂移 | 补一句 |
| 30 | `extract` 游标对「无 id 会话」统一用 `'default'` 键 | 两个会话互吃扫描窗口 | 用会话对象身份做键 |
| 31 | `TITLE_CACHE` / `PATH_CACHE` 全仓库唯一无上限缓存 | 长跑内存缓慢增长 | 用 `trimMap` 限一下 |
| 32 | `build-client.mjs` 的 `ORDER` 硬编码；符号扫描 `DECL_RE` 只认 4 空格的 `var/function` | 新增片段漏登记会静默丢失；`let/const` 逃检 | 自动扫描 + 放宽正则 |
| 33 | `revOf` 三处逐字重复；`pad2`/`dateKeyOf` 同构重复；测试断言工具在 40+ 文件逐份复制 | 改一处要改 N 处 | 收敛到 `constants.js` 与 `tests/helpers/assert.mjs` |
| 34 | `summarizeConversations` 成死代码仍从门面导出；`askAgentToWrite` 的 `force` 参数恒 false | 误导读者 | 删掉或标注 |
| 35 | `docs/preview.html` 手工复制 `styles.js` 整套 CSS | 改样式后预览过期 | 生成或加一致性检查 |

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

## 七、建议的下一轮顺序

1. **一致性**：#8（`maxRecords` 两处夹取）、#12（控制字符）、#13/#14（合并与 id）—— 都是小改动、纯正确性。
2. **日志与请求层**：#9（日志注入）、#10（413）、#11（TOCTOU）。
3. **性能**：#1、#3、#5（最常被调用的三条）。
4. **前端**：#22（config 单点）、#24（后台暂停）。
5. **重构**：#26–#28 三个大文件（要单独一轮，且必须在测试稳定之后）。

---

*清单随代码演进维护；修掉一条就把那条划掉并写进 `CHANGELOG.md`。*
