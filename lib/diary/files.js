/**
 * 摘录 · files.js
 * 由 lib/diary.js 按职责拆出（2026-11-06 模块化重构）。
 * 2026-11-21 / 0.10.0：落盘从「公开/私密两篇」改成「一篇摘录」。
 */
import { atomicWrite, diaryExcerptDir, diaryExcerptPath, diaryJsonlPath, ensureDirs, exists, isDiaryDateKey } from '../paths.js'
import { diaryIsCompleteFor, parseDateLocal, todayKey } from '../diary/completion.js'
import { loadConfig } from '../store.js'
import { note } from '../env.js'
import { normalizeExcerpt, renderExcerptFile } from './excerpt.js'
import { pruneConversations } from '../retention.js'
import { readdirSync, statSync } from 'node:fs'


/**
 * 扫描新事件，把 user/message + assistant/message 追加到当天 JSONL。
 *
 * 跟 extract.js 的 collectCandidates 同款游标机制，但：
 *   ① 同时收 assistant/message（日记需要看到双方对话）
 *   ② 收所有真人 user/message（不做 worthRemembering 过滤 —— 日记需要完整流水）
 *   ③ 游标独立，不干扰记忆提取
 *
 * @returns {{ scanned: number, appended: number }}
 */
/** 上次检查保留期的日子：一天最多一次，避免每轮都去读目录。 */
let lastCleanupDay = ''


/**
 * 2026-11-05 修 P1-5 的另一半：可配置的对话流水保留期。
 * 默认两个开关都是 0 —— 这个函数每轮被调用，但什么都不会删。
 * 老版本「直接删旧流水」被撤掉过一次（删掉以后那一天永远补不回来），
 * 所以现在必须用户显式设 conversationRetentionDays / conversationMaxTotalBytes 才动，
 * 且只删严格的整天 .jsonl，今天与未来永远保留。细节见 lib/retention.js。
 */
export function maybePruneConversations() {
  const day = todayKey(Date.now())
  if (lastCleanupDay === day) return
  lastCleanupDay = day
  const config = loadConfig()
  if (Number(config.conversationRetentionDays) <= 0 && Number(config.conversationMaxTotalBytes) <= 0) return
  const report = pruneConversations({ config, today: day, dryRun: false })
  if (report.failed.length > 0) {
    note('diary', `对话流水保留期：${report.failed.length} 个旧文件删不掉，下次再试`)
  }
}


/**
 * 把一天的摘录写进 `agents/diary/excerpt/YYYY-MM-DD.md`，返回是否成功。
 *
 * 格式（首行日期、每条 `- `、上限条数、优先条目）全由 excerpt.js 统一处理 ——
 * 不管正文是她通过工具写的、还是规则化兜底拼的，落盘形状只有这一份定义。
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} text 裸条目文本（可以带 `- `、标题、时间戳，会被洗掉）
 * @param {object} [options]
 * @param {number} [options.maxLines] 上限条数（默认读配置 excerptMaxLines）
 * @param {number} [options.skipIfNewerThan=0]
 *   2026-11-07 R05 / P1-D2：兜底写盘前再看一眼文件。>0 时，如果目标文件的 mtime
 *   比这个时间戳新，就**放弃覆盖**并返回 false。
 *
 *   场景：`waitForWrite` 判定超时 → 走插件兜底 → 她其实在判定后几秒才落盘
 *   （followup 慢）→ 兜底把她刚写的那篇覆盖。返回 false 而不是 true，
 *   让启动流程判「不完整」→ 下一轮自动收敛，不会无限重试。
 */
export function writeExcerptFile(dateStr, text, options = {}) {
  // 声明在 try 外：catch 里的日志也要用它（块级 const 在 catch 里取不到）。
  let target = String(dateStr ?? '')
  try {
    // 2026-11-05 修 P0-2：以前 dateStr 直接进文件名，`../../../AGENT`
    // 能把人格文件覆盖成摘录正文。paths.js 里的断言是最后一道，
    // 这里提前挡住是为了返回 false 而不是抛异常打断主流程。
    if (!isDiaryDateKey(dateStr)) {
      note('diary', `拒绝写摘录：日期非法（收到「${target}」）`)
      return false
    }
    target = diaryExcerptPath(dateStr)
    ensureDirs()
    // 2026-11-07 P1-D2：兜底写盘前再确认一次「她是不是刚写好了」。
    const skipAfter = Number(options.skipIfNewerThan) || 0
    if (skipAfter > 0) {
      try {
        const mtime = statSync(target).mtimeMs
        if (mtime > skipAfter) {
          note('diary', `${target} 在她那边刚写过（mtime 比兜底基线新），兜底放弃覆盖`)
          return false
        }
      } catch {
        /* 文件不存在 = 没有覆盖风险，照常写 */
      }
    }
    const maxLines = options.maxLines ?? (Number(loadConfig().excerptMaxLines) || 15)
    const body = String(text ?? '').trim()
    const { lines } = normalizeExcerpt(body, { maxLines })
    // 有正文但洗完一条不剩（全是感受句/格式外壳）= 这份产出不可用。
    // 不能落一个「今天没有对话」的空壳去掩盖「模型写了但写歪了」。
    if (body !== '' && lines.length === 0) {
      note('diary', `摘录内容洗完一条都不剩（${target}），这份不采用`)
      return false
    }
    const normalized = renderExcerptFile(dateStr, lines)
    const written = atomicWrite(target, normalized)
    // 这里曾经是「日志说已写入、磁盘上没有」的现场：atomicWrite 静默失败，
    // 下一行照样打「已写入」然后 return true，调用方以为写成了。
    if (written?.ok !== true) {
      note('diary', `写摘录文件失败（${target}）：${written?.error ?? '未知原因'}`)
      return false
    }
    note('diary', `摘录已写入：${target}（${lines.length} 条 / ${normalized.length} 字）`)
    return true
  } catch (error) {
    note('diary', `写摘录文件失败（${target}）：${error instanceof Error ? error.message : error}`)
    return false
  }
}


/**
 * 等一个文件被写入（mtime 变化或新建）。
 *
 * 用来判断 agent 有没有真的把公开日记写下去 —— 写完了才投私密那条。
 * 等不到也照样投（超时兜底）：不能因为这一步卡住就丢掉一整天的日记。
 *
 * 2026-11-06 第二份审查 H-1：`timeoutMs` 来自配置，必须有硬上限（MAX_WAIT_MS）。
 *
 * @returns {Promise<boolean>} 是否在超时前等到
 */
export const MAX_WAIT_MS = 600_000
export async function waitForWrite(file, timeoutMs, intervalMs = 2000) {
  // 2026-11-06 第二份审查 H-1 第二道：这里也夹一次。
  // 调用方传进来的可能是配置值（`diaryAgentTimeoutMs`），而配置可以被手改成 1e12 ——
  // 那这个 while 会空转 31 年，并且它跑在「锁已经被拿走」的日记链里。
  const budget = Math.min(MAX_WAIT_MS, Math.max(1_000, Math.trunc(Number(timeoutMs) || MAX_WAIT_MS)))
  let before = 0
  try {
    before = exists(file) ? statSync(file).mtimeMs : 0
  } catch {
    before = 0
  }
  const start = Date.now()
  while (Date.now() - start < budget) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    try {
      if (exists(file) && statSync(file).mtimeMs > before) return true
    } catch {
      /* 读不到就继续等 */
    }
  }
  return false
}


// --------------------------------------------------------------------------
// 启动补写
// --------------------------------------------------------------------------

/** 有没有写过任何一天摘录（excerpt 目录里有 md 就算）。 */
function hasAnyExcerpt() {
  try {
    const dir = diaryExcerptDir()
    if (!exists(dir)) return false
    return readdirSync(dir).some((file) => String(file).endsWith('.md'))
  } catch {
    return false
  }
}


/**
 * 找「今天之前最近该补的那一天」。
 *
 * 两条门槛，缺一就不补：
 *   ① 写过至少一篇日记 —— 补写是「补断档」，不是「回溯历史」。
 *      刚装上插件时过去 7 天都没有日记，不设这道门槛会每次启动补一篇、
 *      连补 7 篇，而那些日子连对话流水都没有。
 *   ② 那天有对话 JSONL —— 没对话的日子补出来只能是意识流，
 *      价值低，还会让日记看着连续其实空洞。
 *
 * 只返回最近的一个，更早的不补（一次补十篇只会让日记变成流水账）。
 *
 * @returns {string|null} 'YYYY-MM-DD' 或 null（没有该补的日子）
 */
export function findMissingDay(todayStr, maxDays = 7) {
  const dayStart = parseDateLocal(todayStr).getTime()
  if (Number.isNaN(dayStart)) return null

  if (!hasAnyExcerpt()) return null

  for (let i = 1; i <= maxDays; i += 1) {
    const key = todayKey(dayStart - i * 24 * 60 * 60 * 1000)
    // 2026-11-01：判据从「文件存在」改成「完整写过」——
    // 窗口闭合前写的只有半天，第二天仍然该重写，不能算补过。
    if (diaryIsCompleteFor(key)) continue
    if (!exists(diaryJsonlPath(key))) continue
    return key
  }
  return null
}
