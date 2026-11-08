/**
 * store.js —— 记忆卡 / 目的状态 / 心情状态的读写门面（唯一碰盘的地方）。
 *
 * ── 版权与来源 ──
 *   记忆机制的设计借鉴 dsh-fish-memory
 *   （https://github.com/Yuuyuko-uu/dsh-fish-memory），原作者 Yuuyuko-uu，
 *   《Yuuyuko-uu 插件许可 1.2》，逐字原文见 LICENSES/Yuuyuko-uu-PLUGIN-1.2.txt；
 *   改动清单见 THIRD-PARTY-NOTICES.md §3.3。
 *
 * 为什么要有这一层：
 *   记忆卡有三处消费者（注入、工具、设置页 API），每处自己拼路径、自己 load/save，
 *   迟早出现「注入读的是这份、工具写的是另一份」。集中到一处，路径和写盘策略只有一份。
 *
 * 缓存策略：
 *   每张卡在进程内缓存一份，按文件 mtime 判断是否需要重读 ——
 *   因为注入是**每回合**都跑的，每次都 readFile 会让一个回合多几次同步 I/O。
 *   工具/API 写完会主动失效缓存，所以同一进程内的写入立刻可见。
 *
 * 心情状态同款模式，按 cwd 各缓存一份（mood/ 目录下，一份心情跟一份人格走）。
 *   不做 feiyu-mood 历史迁移（2026-10-28 用户明确说记录可以不迁）—— 从空白起步。
 */
// 落库前的硬过滤（2026-10-30）：任务/进度类候选直接丢，阈值按 kind 挑。
// 放在 extract.js 里是因为那边已经有一套「什么算人话」的判据，别再开第二处口径。
// 2026-11-04：每日健康一行（只写 soul.log，不进提示词）。
// 挂在这里是故意的：maintain 本来就一天跑一次，不需要另起定时器。

/**
 * 公共 API 门面：实现已迁到 lib/state/，这里固定对外导出集合，
 * 是宿主与测试唯一稳定的 import 路径，**永久保留，不再删除**。
 * 内部模块可任意重组；改这里的导出必须同步 tests/contract/exports.snapshot.json
 * 并带 SOUL_SNAPSHOT_REASON 留痕（门禁见 exports.snapshot.test.js）。
 */
export { CONFIG_FILE, DEFAULT_CONFIG, PURPOSE_FILE, loadConfig, purposeState, resetCaches, saveConfig, savePurposeState } from './state/cache.js'
export { cardsFor, globalCard, memoryHealth, projectCard, saveGlobalCard, saveProjectCard, writeMemory } from './state/cards.js'
export { allMoodStates, applyMoodDelta, decayMoodFor, migrateMoodFiles, moodState, moodStats, pullDrivesByEmotion, resetMood, saveMoodState } from './state/mood-state.js'
export { maintain, writeAutoMemories } from './state/maintain.js'
export { memoryStats, renderMemoryBlock, renderMemoryBlockRecalled } from './state/render.js'
export { normalizeCard } from './memory.js'
