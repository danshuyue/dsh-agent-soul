/**
 * diary.js —— 智能体日记：开机补写 + 看门狗补写，让 agent 自己写公开 + 私密两篇。
 *
 * ⚠️ 2026-11-06 审计 Q2：这份文件头原来描述的是**已经不存在的实现**
 *    （22:00 定点触发 + LLM 摘要 + 读最近 4 天日记 + 按 22:00 分界）。
 *    实际早就换成下面这套，改代码前先看这里，不要照旧描述理解。
 *
 * 核心流程（现状）：
 *   ① tick() 每轮注入时，扫描新事件追加到当天 JSONL（collectForDiary）
 *   ② 触发方式：启动后 +5 秒跑一次，之后每 diaryWatchdogMinutes（默认 30 分钟）
 *      由看门狗再检查一次 —— 没有 22:00 定点闹钟
 *   ③ **写的是「昨天」**（2026-10-31 树树定）：日记本来就是回头看，
 *      昨天的窗口 00:00–24:00 已经闭合；开机补和一直不关机走同一条逻辑
 *   ④ 分界线是**自然日**，不是 22:00；JSONL 按自然日命名，不再跨两天裁剪
 *   ⑤ 日记会话是【绑定】来的（2026-10-31）：设置页把会话 id 写进
 *      config.diarySessionId，投递只认这个会话。自己 agents.create 造出来的会话
 *      拿不到宿主的 setup/installSelection，没有标准工具集，agent 永远写不出文件
 *   ⑥ agent 收到消息后自己用文件工具写 public/YYYY-MM-DD.md + private/YYYY-MM-DD.md
 *      两篇分两条消息投：写在同一条里的话，私密历史就摆在下面，她写公开那一步时
 *      已经看到了本不该给人看的内容
 *   ⑦ 超时后走 composeDiaryText 的 LLM 兜底（diaryMaxSummaryChars 只对这条
 *      兜底路径的截断长度生效，不是正文摘要）
 *   ⑧ 完整性判据 diaryIsCompleteFor（lib/diary/completion.js）
 *
 * ── 触发消息的 source ──
 *   用 { kind: 'schedule' }，这样 extract.js 会跳过它（不进记忆），
 *   mood.js 也跳过（不影响心情），日记扫描自己也跳过（不进 JSONL）。
 *   agent 仍正常处理这条消息。
 */
  // 2026-10-31：writeDiaryFile 要用它落盘。第一次跑就因为漏了这个 import
  // 报 "atomicWrite is not defined" —— 生成都成功了，死在最后一步。
  // 2026-11-05 修 P0-2：写面前先挡一道，别让非法日期拼进路径。
// sessionModelOf 是零 IO 纯函数，直接取叶子模块，不再经过带 fetch / WeakMap 的心情主模块

/**
 * 公共 API 门面：实现已迁到 lib/diary/，这里固定对外导出集合，
 * 是宿主与测试唯一稳定的 import 路径，**永久保留，不再删除**。
 * 内部模块可任意重组；改这里的导出必须同步 tests/contract/exports.snapshot.json
 * 并带 SOUL_SNAPSHOT_REASON 留痕（门禁见 exports.snapshot.test.js）。
 */
export { collectForDiary, compressFeedText, readConversationRows, readDiaryConversations, readRecentChat, resetDiaryCursor } from './diary/feed.js'
export { buildMoodBlocks, composeDiaryText, composePrivateMessage, composePublicMessage, diaryWindowOf, digestDiaries, readRecentDiaries, summarizeConversations } from './diary/compose.js'
export { findMissingDay, waitForWrite, writeDiaryFile } from './diary/files.js'
export { __resetDiaryInFlightForTest, diaryAgent, regenerateDiary, runCatchUp, runDiaryOnce, startDiaryTimer } from './diary/scheduler.js'
export { todayKey, yesterdayKey, parseDateLocal, scheduleMinutes, diaryDayBoundaries, diaryIsCompleteFor } from './diary/completion.js'
