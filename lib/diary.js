/**
 * diary.js —— 摘录（excerpt）：开机补写 + 看门狗补写，一天一篇「一行一条」。
 *
 * ⚠️ 2026-11-21 / 0.10.0：这个文件原来是「日记：公开 + 私密两篇」。现在语义变了 ——
 *    产出只有一篇摘录（`agents/diary/excerpt/YYYY-MM-DD.md`），格式是纯事实条目；
 *    兜底也从「插件再调一次模型生成一篇」改成「从对话流水规则化提取」。
 *    改代码前先看这里，不要照旧描述理解。
 *
 * 核心流程（现状）：
 *   ① tick() 每轮注入时，扫描新事件追加到当天 JSONL（collectForDiary）
 *   ② 触发方式：启动后 +5 秒跑一次，之后每 diaryWatchdogMinutes（默认 30 分钟）
 *      由看门狗再检查一次 —— 没有 22:00 定点闹钟
 *   ③ **写的是「昨天」**（2026-10-31 树树定）：昨天的窗口 00:00–24:00 已经闭合
 *   ④ 分界线是**自然日**，不是 22:00；JSONL 按自然日命名
 *   ⑤ 摘录会话是【绑定】来的：设置页把会话 id 写进 config.excerptSessionId
 *      （0.10.0 之前的 diarySessionId 会自动迁移过来），投递只认这个会话
 *   ⑥ 她收到一条消息后用 soul_diary 工具写 excerpt/YYYY-MM-DD.md；
 *      没写成 → 规则化兜底（conversations/*.jsonl 每行取 role + 首句，不调模型）
 *   ⑦ 完整性判据 diaryIsCompleteFor（lib/diary/completion.js）
 *
 * ── 触发消息的 source ──
 *   用 { kind: 'schedule' }，这样 extract.js 会跳过它（不进记忆），
 *   mood.js 也跳过（不影响心情），日记扫描自己也跳过（不进 JSONL）。
 */
// 2026-10-31：writeExcerptFile 要用它落盘。第一次跑就因为漏了这个 import
// 报 "atomicWrite is not defined" —— 生成都成功了，死在最后一步。
// 2026-11-05 修 P0-2：写面前先挡一道，别让非法日期拼进路径。

/**
 * 公共 API 门面：实现已迁到 lib/diary/，这里固定对外导出集合，
 * 是宿主与测试唯一稳定的 import 路径，**永久保留，不再删除**。
 * 内部模块可任意重组；改这里的导出必须同步 tests/contract/exports.snapshot.json
 * 并带 SOUL_SNAPSHOT_REASON 留痕（门禁见 exports.snapshot.test.js）。
 */
export { collectForDiary, compressFeedText, readConversationRows, readDiaryConversations, readRecentChat, resetDiaryCursor } from './diary/feed.js'
export { readRecentExcerpts, renderRecentExcerpts } from './diary/history.js'
export {
  EMPTY_DAY_LINE,
  PRIORITY_WORDS,  excerptLinesFromFile,
  excerptLinesOf,
  isPriorityLine,
  normalizeExcerpt,
  orderExcerptLines,
  renderExcerptFile
} from './diary/excerpt.js'
export { FALLBACK_MAX_ROWS, excerptFromConversations } from './diary/fallback.js'
export { composeExcerptMessage } from './diary/compose.js'
export { findMissingDay, waitForWrite, writeExcerptFile } from './diary/files.js'
export { diaryAgent } from './diary/agent.js'
export { __resetDiaryInFlightForTest, regenerateDiary, runCatchUp, runDiaryOnce, startDiaryTimer } from './diary/scheduler.js'
export { todayKey, yesterdayKey, parseDateLocal, scheduleMinutes, diaryDayBoundaries, diaryIsCompleteFor } from './diary/completion.js'
