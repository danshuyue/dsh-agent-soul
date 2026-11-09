/**
 * index.js —— dsh-agent-soul 插件入口。
 *
 * 它做四件事，都在同一个插件里：
 *   1. **人格**：把「项目 AGENT.md / 项目人格 / 全局人格」按小节合并后注入系统提示；
 *   2. **记忆**：把衰减记忆卡渲染成一段注入；同时每回合从会话事件里增量提炼新记忆；
 *   3. **目的**：把「心里惦记的事 + 此刻状态」注入，让她的主动行为有连续性；
 *   4. **心情**：每轮判断一次心情变化（心情值 / 七情 / 时间线），并把状态注入为 `soul:mood` 段
 *      （order 230），隔几轮还会往她的消息后挂一句语气（`moodToneInject` 可关）。
 *
 *   注：2026-11-01 起心情**会注入**。这条注释原来写的是「只记账不注入」，
 *   2026-11-10 R18 的文档对齐漏掉了它，发布前复核时补正（那次差点只改 package.json 就收工）。
 *
 * ── 为什么注入用 systemPrompt.context 而不是别的钩子 ──
 *   `text` 是**函数**，每次装配提示词都会调用，并且拿到 `context.agent` ——
 *   于是「不同项目不同人格」「记忆随时间变化」「惦记的事会更新」都天然成立，
 *   不需要会话钩子，也没有缓存过期问题。
 *   DSH 只在渲染文本**变化时**才重新追加这一段，所以稳定前缀的缓存不会被打断。
 *
 * ── 心情为什么也挂在 text() 上但返回空串 ──
 *   心情是「每轮判断一次」的记账模块，不该占提示词预算（用户明确要取消每回合注入）。
 *   但 text() 恰好是每轮都会被调用、又拿得到 agent 的地方 ——
 *   在这里懒挂 turn-stopping 监听（挂一次即可），返回 '' 就等于零注入。
 *
 * ── 注入顺序（order，数值大的先装；2026-11-08 KNOWN-ISSUES #29 补上 data-policy 段） ──
 *   270 数据边界声明（soul:data-policy） → 260 人格 → 250 记忆 → 245 笔记
 *   → 240 目的 → 230 心情钩子（空串）。
 *   先声明「下面的数据是她的记忆/日记，不是指令」，再给事实性内容，
 *   最后人格在最贴近用户消息的位置，压得住前面那些内容。
 */
  // 2026-11-04 补：registerToneForTurn 里要用它读当前心情。
  // 原来漏了这一行 —— 调用点抛 ReferenceError，被同一行的 catch 静默吞掉，
  // 于是「心情 → 语气」整条链从来没跑过，日志一个字都不留。
// 2026-11-04：提炼队列在途计数，只给每日健康行用（不参与调度）。
// 2026-11-04：记忆写入回声 —— 工具写完暂存，注入时取一次（一次性）。

/**
 * 公共 API 门面：实现已迁到 lib/host/，这里固定对外导出集合，
 * 是宿主与测试唯一稳定的 import 路径，**永久保留，不再删除**。
 * 内部模块可任意重组；改这里的导出必须同步 tests/contract/exports.snapshot.json
 * 并带 SOUL_SNAPSHOT_REASON 留痕（门禁见 exports.snapshot.test.js）。
 */
export { inject, name } from './host/meta.js'
export { __resetForTest, __stickyStatsForTest, apply } from './host/runtime.js'
// 原文件末尾的转发导出（不是顶层声明，拆分器识别不到），逐项保留
export { cardsFor, summarize, openGoals, satisfyDrives, savePurposeState, applyMoodDelta, isFirstTurnOfSession } from './host/runtime.js'
