/**
 * memory.js —— 记忆卡引擎（纯 node: 内置模块，可单测，不依赖 DSH 也不依赖模型）。
 *
 * 设计目标：让「记忆」像人的记忆，而不是一张越攒越大的表。
 *
 *   · 重要度决定降多快：和主人相关、有情绪、约定、第一次 → 降得慢
 *   · 遗忘不是删除：先变短、再变含糊、最后只剩「好像有这么件事」
 *   · 永久锚点：pinned / 初次相遇 → 永远清晰，容量压缩时也不淘汰
 *   · 复习效应：被再次提起 → 召回次数 +1、可能回升一档
 *   · 一次只动一格：每天最多降一档，所以是「慢慢模糊」而不是某天突然想不起来
 *   · 容量有上限：超了从最不重要的开始压，不粗暴截断字符串
 *
 * 为什么规则全是纯函数：
 *   记忆整理每回合都可能跑。要是靠模型判断「这条重不重要」，
 *   一天几十个回合就是几十次额外调用 —— 又慢又烧钱，还没法写测试。
 *   这里全部用正则 + 数值，输入确定输出就确定。
 *
 * 数据形状（一条记录）：
 *   {
 *     id, text, title, importance, kind, clarity, tags,
 *     createdAt, lastSeenAt, recallCount,
 *     pinned, isInitial, source, scope
 *   }
 */
// 2026-10-31：addRecord 里要记「近似重复」的日志。第一次写忘了 import，
// 运行时会 "note is not defined" —— 和今天上午 atomicWrite 那次一个毛病。
// 2026-11-04：countCardWriteFailure 是每日健康行的计数（见 env.js）。

/**
 * 公共 API 门面：实现已迁到 lib/memory/，这里固定对外导出集合，
 * 是宿主与测试唯一稳定的 import 路径，**永久保留，不再删除**。
 * 内部模块可任意重组；改这里的导出必须同步 tests/contract/exports.snapshot.json
 * 并带 SOUL_SNAPSHOT_REASON 留痕（门禁见 exports.snapshot.test.js）。
 */
export { CLARITY_LABEL, CLARITY_ORDER, DAY_MS, DEFAULTS, KIND_LABEL, MEMORY_KINDS, MEMORY_VERSION, normalizeKind } from './memory/constants.js'
export { normalizeConfig } from './memory/config.js'
export { emotionScore, redact } from './memory/signals.js'
export { ownerImportant, scoreRecord, targetClarity } from './memory/scoring.js'
export { createCard, mergeCards, normalizeCard } from './memory/card.js'
export { corruptInfoOf, isCardReadonly, loadCard, makeArchiver, recallArchived, saveCard } from './memory/card-io.js'
export { addRecord, applyDecay, classifyScope, compactCard, daysSince, forgetRecord, setPinned, touchRecords } from './memory/mutation.js'
export { renderCard, renderRecallOnly, renderRecalledBlock, status } from './memory/render.js'
export { recall, recallQueryTerms, relatedScore } from './memory/recall.js'
