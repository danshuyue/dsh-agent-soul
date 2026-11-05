/**
 * retention.js —— 对话流水的保留期与体积上限（P1-5 的另一半，2026-11-05）。
 *
 * 报告 P1-5 指出：`conversations/*.jsonl`、`archive.jsonl` 全明文、无保留期、无大小上限，
 * 实测 30~100KB/天且只涨不消，「遗忘」只是移出提示词、磁盘上永久留存。
 * S2 已经补了 0600 与日志脱敏，剩下这半是**生命周期**。
 *
 * 设计上极度保守，因为这里动的是用户数据：
 *   - 两个开关默认都是 **0 = 永不自动删除**；老配置文件没有这两个键，
 *     `loadConfig()` 的 `{...DEFAULT_CONFIG, ...raw}` 会自动补 0，一个文件都不动。
 *   - 只认 `<diaryConversationsDir()>/YYYY-MM-DD.jsonl` 这一种严格命名；
 *     `.bak` / `.corrupt-*` / `*.md` 日记 / `notes/` / `secrets/` / 子目录一律不碰。
 *   - 只按整天文件删，不截断、不改写、不解析内容；今天与未来的文件永不删。
 *   - `archive.jsonl` 是 README 承诺的「忘了也能查回来」，**本模块完全不管**。
 *   - `dryRun` 默认 true 语义由调用方决定；真删时每个文件都记日志，失败逐条报。
 *
 * 计划与执行分开：planConversationPrune 是纯函数，便于清单式回归测试。
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { note } from './env.js'
import { diaryConversationsDir } from './paths.js'

export const DAY_MS = 24 * 60 * 60 * 1000
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/** 本地日期键，避免为了一个函数把整个 diary.js 拖成循环依赖。 */
export function dateKeyOf(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * 纯函数：算出该删哪些文件。
 *
 * @param {Array<{name: string, bytes?: number}>} entries 目录项
 * @param {{ today?: string, keepDays?: number, maxBytes?: number }} options
 *   keepDays  = 保留最近 N 天（含今天）；0 = 不按时间删
 *   maxBytes  = 目录总量上限（字节）；0 = 不按体积删
 * @returns {{ skipped: boolean, toDelete: Array<{name:string, reason:string}>,
 *            kept: string[], totalBytes: number, keptBytes: number }}
 */
export function planConversationPrune(entries, { today = dateKeyOf(Date.now()), keepDays = 0, maxBytes = 0 } = {}) {
  const days = Math.max(0, Math.trunc(Number(keepDays) || 0))
  const budget = Math.max(0, Math.trunc(Number(maxBytes) || 0))
  const skipped = days === 0 && budget === 0

  // 只收严格命名 + 日期真实存在的文件。无效日期（2026-13-45）一律不删，宁可留着。
  const dated = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = String(entry?.name ?? '')
    const match = DATE_FILE_RE.exec(name)
    if (match === null) continue
    const key = match[1]
    if (!Number.isFinite(Date.parse(`${key}T00:00:00Z`)) || dateKeyOf(Date.parse(`${key}T00:00:00Z`)) !== key) continue
    dated.push({ name, key, bytes: Math.max(0, Math.trunc(Number(entry.bytes) || 0)) })
  }
  dated.sort((a, b) => a.key.localeCompare(b.key))

  // 「保留最近 N 天」= 今天 + 前 N-1 天；超出这个窗口的最旧文件先删。
  const cutoffKey = days > 0
    ? dateKeyOf(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY_MS)
    : ''
  const deletedNames = new Set()
  const toDelete = []
  for (const item of dated) {
    // 今天与未来永远保留：正在写的流水不能删，时钟回拨也别误删。
    if (item.key >= today) continue
    if (days > 0 && item.key < cutoffKey) {
      toDelete.push({ name: item.name, reason: 'retention' })
      deletedNames.add(item.name)
    }
  }

  // 体积预算：在「没被过期删」的文件里，从最旧的整天文件开始删到不超预算。
  const survivors = dated.filter((item) => !deletedNames.has(item.name))
  let keptBytes = survivors.reduce((sum, item) => sum + item.bytes, 0)
  if (budget > 0) {
    for (const item of survivors) {
      if (keptBytes <= budget) break
      if (item.key >= today) continue // 同样不动今天
      toDelete.push({ name: item.name, reason: 'budget' })
      deletedNames.add(item.name)
      keptBytes -= item.bytes
    }
  }

  return {
    skipped,
    toDelete,
    kept: dated.filter((item) => !deletedNames.has(item.name)).map((item) => item.name),
    totalBytes: dated.reduce((sum, item) => sum + item.bytes, 0),
    keptBytes
  }
}

/**
 * 扫描真实目录并执行清理。
 * 默认 dryRun=true：只报告不动手，方便用户/设置页先看清会删什么。
 */
export function pruneConversations({ config = {}, today = dateKeyOf(Date.now()), dryRun = true } = {}) {
  const options = {
    today,
    keepDays: config.conversationRetentionDays,
    maxBytes: config.conversationMaxTotalBytes
  }
  const days = Math.max(0, Math.trunc(Number(options.keepDays) || 0))
  const budget = Math.max(0, Math.trunc(Number(options.maxBytes) || 0))
  if (days === 0 && budget === 0) {
    return { skipped: true, dryRun, toDelete: [], deleted: [], failed: [], totalBytes: 0, keptBytes: 0 }
  }

  const dir = diaryConversationsDir()
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        try { return { name: entry.name, bytes: statSync(join(dir, entry.name)).size } } catch { return null }
      })
      .filter((entry) => entry !== null)
  } catch (error) {
    // 目录不存在 / 读不了都不该影响主流程。
    return {
      skipped: false, dryRun, toDelete: [], deleted: [], failed: [],
      totalBytes: 0, keptBytes: 0, error: error instanceof Error ? error.message : String(error)
    }
  }

  const plan = planConversationPrune(entries, { today, keepDays: days, maxBytes: budget })
  const deleted = []
  const failed = []
  if (dryRun === false) {
    for (const { name, reason } of plan.toDelete) {
      try {
        unlinkSync(join(dir, name))
        deleted.push(name)
        note('diary', `对话流水保留期清理：删掉 ${name}（${reason === 'retention' ? '超过保留天数' : '超过体积上限'}）`)
      } catch (error) {
        failed.push(name)
        note('diary', `对话流水保留期清理失败：${name}（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
  }
  return { ...plan, dryRun, deleted, failed }
}
