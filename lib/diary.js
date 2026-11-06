/**
 * diary.js —— 智能体日记：每天到点触发，让 agent 自己写公开 + 私密日记。
 *
 * 核心流程：
 *   ① tick() 每轮注入时，扫描新事件追加到当天 JSONL（collectForDiary）
 *   ② 定时器到点（默认 22:00）触发 runDiaryOnce：
 *      读 JSONL → LLM 摘要 → 读最近 4 天日记 → 投第一条消息（公开）→ agent 写完
 *      → 投第二条消息（私密）
 *   ③ 日记会话是【绑定】来的（2026-10-31）：设置页把当前会话 id 写进
 *      config.diarySessionId，投递只认这个会话。自己 agents.create 造出来的会话
 *      拿不到宿主的 setup/installSelection，没有标准工具集，agent 永远写不出文件。
 *   ④ agent 收到消息后自己用文件工具写 public/YYYY-MM-DD.md + private/YYYY-MM-DD.md
 *      两篇分两条消息投：写在同一条里的话，私密历史就摆在下面，她写公开那一步时
 *      已经看到了本不该给人看的内容。
 *   ⑤ 启动时 catch_up：找最近缺失日，只补那一天
 *
 * 设计参考：
 *   - 对话扫描：extract.js 的 cursor + snapshotEvents 模式（独立游标，不干扰记忆提取）
 *   - LLM 调用：mood.js 的 judgeMood 模式（流式 + 超时 + 兜底）
 *   - 定时器：dsh-onebot-channel proactive.js 的 setTimeout 自调度模式
 *   - 消息投递：dsh-onebot-channel deliver.js 的 agent.followup 模式
 *
 * ── 一天的分界线 ──
 *   不是自然日 00:00，而是 schedule 时间（默认 22:00）。
 *   日记「2026-10-29」覆盖：2026-10-28 22:00 ~ 2026-10-29 22:00。
 *   JSONL 按自然日命名，触发时读两天文件再按分界线裁剪。
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
