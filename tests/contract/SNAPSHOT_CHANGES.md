# 契约快照变更记录

> 三条契约门禁（导出名快照 / 行为 golden / 依赖图）是「零行为变化重构」的硬证据。
> 更新**已有**快照必须带 `SOUL_SNAPSHOT_REASON`，脚本会自动在下面追加一行；
> 没有对应理由的快照变更不应被合并 —— 那往往意味着有人用刷基线的方式消掉了一条红。
>
> 用法：
> ```bash
> SOUL_UPDATE_SNAPSHOT=1 SOUL_SNAPSHOT_REASON="为什么允许这次变化" \
>   node tests/contract/exports.snapshot.test.js
> ```
> 首次生成快照（还没有基线文件）不需要理由。

## 记录

- 2026-11-06 · 基线建立 · P0 生成 `exports.snapshot.json` 与 `behavior-golden.json`；P9 因新增 `lib/state/file-cache.js` 登记过一次导出快照（此条为补记，P11 之前的更新尚未强制留痕）。

- 2026-11-06T04:55:10.186Z · exports.snapshot.json · P12 新增 lib/retention.js 的 rotateArchiveIfNeeded 导出（归档分片，默认关闭）

- 2026-11-06T05:44:05.724Z · exports.snapshot.json · P16 真拆：新增 lib/http/routes/*（7 文件）与 lib/host/runtime/*（12 文件），27 个路由 handler 与 6 个装配段从巨型主体搬出；六个公共门面与 host/runtime.js 的对外导出集合不变

- 2026-11-06T06:13:16.561Z · behavior-golden.json · 行为 golden 改为固定 TZ=UTC：renderCard 头部按本地时区格式化，基线原来在 UTC+8 生成，CI 跑在 UTC 时哈希不同（长度相同、字节不同）导致首次推送即红灯。行为本身未变。

- 2026-11-06T10:24:37.203Z · exports.snapshot.json · 2026-11-06 审计 P0/P1 修复新增三个公共符号：moodStepOf（心情步长统一入口，取代两处各写一遍的 Math.round/3）、normalizeCwdParam（?cwd= 的绝对路径+目录校验）、isSafeLocalName + SAFE_LOCAL_NAMES（项目人格文件名枚举，堵 P0-1 任意文件读取）。均为新增导出，无既有符号改名。

- 2026-11-06T10:32:22.778Z · exports.snapshot.json · P2-15 新增导出 MIN_FIXED_TOKEN_LENGTH（固定令牌最短长度校验，审计报告指出 fixed 模式对长度零校验）。

- 2026-11-06T13:53:02.408Z · exports.snapshot.json · R02 新增四个公共符号：NUMBER_RANGES（配置数值语义区间表，堵 H-1）、resolvePostCwd（写侧 cwd 唯一入口，堵 M-5）、DIARY_TOTAL_BUDGET_MS（日记总预算常量，堵 H-2）、MAX_WAIT_MS（waitForWrite 硬上限）。都是新增导出，无既有符号改名。

- 2026-11-06T14:54:31.021Z · behavior-golden.json · R03/H-3 把数据边界从 <user_data> 换成不可伪造的 <untrusted_data nonce=…>（闭合标签带内容哈希派生的 nonce），并给人格段加 PERSONA_GUARD 前置声明。renderRecalledBlock / renderNotesBlock 的输出因此变化，行为 golden 与导出快照按新契约重刷。除标签名与 nonce 外，渲染内容与长度预算语义不变。

- 2026-11-06T14:54:31.119Z · exports.snapshot.json · R03/H-3 把数据边界从 <user_data> 换成不可伪造的 <untrusted_data nonce=…>（闭合标签带内容哈希派生的 nonce），并给人格段加 PERSONA_GUARD 前置声明。renderRecalledBlock / renderNotesBlock 的输出因此变化，行为 golden 与导出快照按新契约重刷。除标签名与 nonce 外，渲染内容与长度预算语义不变。

- 2026-11-07T02:44:06.463Z · exports.snapshot.json · R04/P1-S2 把 cwd 的「存在性检查」从 normalizeCwdParam 里拆出来成 isExistingDirectory（纯字符串校验先跑、归属判定通过后才碰磁盘），新增一个导出；同时 UNC/设备路径在字符串阶段直接拒绝。

- 2026-11-07T03:35:51.657Z · exports.snapshot.json · R05/P1-D3 把「还要不要再找她写」的判定抽成纯函数 shouldAskAgain 并导出（原先是 followup 里的一段内联判断，无法单独测试）。行为：force 一定重写；文件不存在要写；since=0 保持旧行为；since>0 时只有比基线新才算她这轮写的。

- 2026-11-07T03:37:15.461Z · exports.snapshot.json · R05/P2-3 把 PowerShell 的超时与熔断期做成可审阅的常量（SHELL_TIMEOUT_MS 20s→6s、SHELL_BREAKER_MS 30s），并把「这次失败要不要熔断」抽成纯函数 shouldTripBreaker 导出以便跨平台测试。

- 2026-11-07T04:07:38.911Z · exports.snapshot.json · R6：Host 信任判定改为「以宿主 connection.requestRejection 为准 + 插件白名单兜底」，新增 checkHostTrust/allowedHostList/isLoopbackHostName/noteRemoteHostOnce 四个导出；同时修正 Origin 与 Host 的端口比较（规范化权威 + 回环间允许不同端口）。

- 2026-11-07T04:28:49.969Z · exports.snapshot.json · R7：L2 把「挑最近 12 条素材」抽成纯函数 pickRecentMaterials（原先内联在 maintain 里，无法单独测）。口径由「数组尾部 12 条」改为「按 lastSeenAt 优先、createdAt 兜底排序取前 12」。

- 2026-11-07T05:52:27.724Z · exports.snapshot.json · R8/P2-12 新增无副作用读卡 readCardQuietly（合并路径与写后回读改用它，避免 loadCard 的 parkCorrupt 把主记忆文件改名）。

- 2026-11-07T06:06:34.033Z · exports.snapshot.json · R9/P2-10 新增模块 core/lru.js（trimMap / touchMap）：把 8 处「超限就整体 clear()」改成只淘汰最旧的，避免第 201 个会话出现时其余会话集体失忆。

- 2026-11-07T06:47:59.737Z · exports.snapshot.json · R10/P2-15 令牌有效期与轮换：新增 TOKEN_TTL_MS、rotateApiToken、apiTokenAge；新增 POST /session/rotate 路由。

- 2026-11-08T07:11:53.227Z · exports.snapshot.json · 新增 lib/core/session-groups.js：日记流水按工作区→会话分组

- 2026-11-08T07:11:53.328Z · behavior-golden.json · 日记对话文本改为按工作区→会话分组（pickConversation 输出多两行标题），行为有意变更

- 2026-11-08T07:43:05.198Z · exports.snapshot.json · R13 修复 KNOWN-ISSUES #9：env.js 新增 sanitizeLogText 导出（清洗 body 派生值进日志）；mood/digest、memory/card、extract 等仅内部实现无导出变化

- 2026-11-08T08:00:11.264Z · behavior-golden.json · 0.9.8 合并两处并行改动后的行为基线：① origin/main 的日记流水按工作区→会话分组（pickConversation 输出多了两行标题）；② R13 的 diary/compose.js 与 feed.js 修复。两者叠加使 behavior-golden 的哈希与长度变化，属有意变更。

- 2026-11-08T08:00:11.361Z · exports.snapshot.json · 0.9.8 合并两处并行改动后的行为基线：① origin/main 的日记流水按工作区→会话分组（pickConversation 输出多了两行标题）；② R13 的 diary/compose.js 与 feed.js 修复。两者叠加使 behavior-golden 的哈希与长度变化，属有意变更。

- 2026-11-08T09:20:12.316Z · exports.snapshot.json · R15 #33 收敛：revOf 三处逐字重复（card.js/card-io.js/state/cards.js）收敛到 constants.js 单份导出；各模块行为不变

- 2026-11-08T09:53:28.863Z · exports.snapshot.json · R16 #27 拆分：compose.js 按职责切四块 —— LLM 调用新建 diary/llm.js（summarizeConversations/composeDiaryText/describeFinishReason）、最近日记读取新建 diary/history.js（readRecentDiaries/digestDiaries）、会话 preset 修复移正到新 diary/agent.js（composeDiarySetup）；compose.js 只留 prompt 组装。函数体逐字未改，lib/diary.js 门面导出集合不变；新增 3 个模块进快照

- 2026-11-08T10:59:30.516Z · exports.snapshot.json · R17 #26 拆分：scheduler.js 投递块迁新 diary/deliver.js（shouldAskAgain/askAgentToWrite 导出）；diaryAgent 并入 diary/agent.js。函数体逐字未改；lib/diary.js 门面导出名不变（原记录误写 R16，发布时由复核方更正）

- 2026-11-08T16:05:37.022Z · exports.snapshot.json · R18：任务 B/C 新增导出 —— middleware.js +LEGACY_CONFIG_KEYS（废弃键兼容表）、新模块 evidence.js（mark/markSnapshot/__resetEvidenceForTest/statuses/reportLine，开关生效证据）；cache.js saveConfig 落盘前剔除废弃键（无导出变化）

- 2026-11-09T04:59:17.506Z · exports.snapshot.json · R19 功能增补：新增 core/situation.js（现实情境纯计算：时段/季节/节日/久未交互）与 diary/to-today.js（昨天想对今天说的话：解析/收窄/落盘）；paths 新增 diaryToTodayPath 与 situationHolidaysPath；routes 新增 POST /diary/to-today（改写/删掉）。均为新功能，无行为回退。

- 2026-11-11T05:02:57.640Z · behavior-golden.json · 日记提示词给历史日记加隔离措辞：11-04 只发生过一次的「删了第二个」被后续几天的日记反复当成当天的事重写，11-10 甚至累加成「第四天」。历史日记块必须标明是过去的事，不能让模型拿它计数。
