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
