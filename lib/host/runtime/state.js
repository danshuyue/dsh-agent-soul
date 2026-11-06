/**
 * 宿主装配 · state.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */



/** dailyHour>0 时用来判「今天已经整理过」。（2026-11-04） */
export const maintainClock = { day: '', at: 0 }



/** 每个会话已经「想起来过」的记忆（原文），避免同一件事连着好几轮刷屏。 */
export const recallSeenBySession = new Map()



// ---- 粘性召回（2026-10-30） ----
//
// 问题：DSH 只在**整段运行时快照文本变化时**才重新追加一条 user/message
// （RuntimeContextProjection.project 里 `if (this.retained?.text === snapshot) return`）。
// 记忆段的相关区是拿「当前这句话」算出来的，句句不同 → 快照每轮都变 →
// 每轮都追加一条，历史里越堆越多，等于每轮重付一遍。
//
// 做法：话题没变就**不重算**，直接返回上次那段文本（必须逐字节一致，
// 不能重新拼串 —— 拼接顺序、时间戳、标点差一个字节都不算「没变」）。
// 只有用户明显换了话题才重算相关区。
//
// 为什么 key 必须用 session id：这张表里存的是别人会话的记忆原文，
// 串一次就是把 A 的私事塞进 B 的提示词。取不到 id 就一律不粘（见 text() 里）。
export const stickyRecallBySession = new Map()



/**
 * 每个会话的扫描游标（2026-10-31）。
 *
 * 只扫「上次之后新增的事件」，不每次从头数 —— text() 是同步的装配路径，
 * 长会话全量重扫等于每一步都白跑几千条事件。
 * 表要有上限：会话开多了不能一直涨。
 */
export const turnCursorBySession = new Map()


export const personaInjectAtBySession = new Map()
