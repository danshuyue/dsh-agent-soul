/**
 * 宿主装配 · runtime.js
 * 由 lib/index.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */

/**
 * 装配入口门面：实现已按职责落到 lib/host/runtime/（state / refine / turns /
 * inject / tick / entry / 六个 segment-*）。这里固定 host/runtime.js 的对外导出集合，
 * 供 lib/index.js 与测试按原路径取用；内部模块可任意重组，本文件导出不变。
 * 改这里的导出必须同步 tests/contract/exports.snapshot.json 并带 SOUL_SNAPSHOT_REASON 留痕。
 */
export { __resetForTest, __stickyStatsForTest, apply } from './runtime/entry.js'
export { applyMoodDelta, cardsFor, savePurposeState } from '../store.js'
export { openGoals, satisfyDrives, summarize } from '../purpose.js'
export { isFirstTurnOfSession } from './runtime/turns.js'
