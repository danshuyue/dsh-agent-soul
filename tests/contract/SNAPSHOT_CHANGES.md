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
