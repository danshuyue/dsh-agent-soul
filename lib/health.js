/**
 * health.js —— 每日健康一行（2026-11-04）。
 *
 * ── 它是什么 ──
 * 每天在 soul.log 里留**一行**工程指标，像体检报告的一行摘要：
 *
 *   [health] 记忆 项目=12 全局=48（pinned 3 / 保护 11 / 模糊 6 / 遗忘 2）归档 137 条｜笔记 4 篇｜日记 最近=2026-11-03 公开/私密=完整｜写盘失败 0｜提炼队列 1
 *
 * ── 它不是什么（这条比上面重要）──
 * 它不是给她的状态，也不进任何提示词：不 import 到注入路径、不写进记忆卡、
 * 不参与心情/人格/目的。它是**给人看的**工程指标 —— 所以单独一个模块，
 * 只往日志写，连返回值都不该被注入那一侧接住。
 *
 * ── 什么时候写 ──
 * 挂在 store.js 的 maintain 末尾。maintain 本来就按 lastDecayDate 一天跑一次，
 * 这里不新起定时器；再用 memory/health.json 记 lastDate，保证：
 *   · 同一天被调很多次（每回合注入、设置页手动维护）也只写一行；
 *   · 进程重启不会把当天那行重写一遍。
 *
 * ── 取不到怎么办 ──
 * 任何一项都可能因为「文件还没建 / 权限 / 盘坏 / 字段变了」取不到。
 * 每项单独 try/catch，取不到的写 `-`，整行照写 —— 一行缺一项，好过当天什么都没有。
 * 全部包在 try/catch 里：它在注入路径上被调用，**任何情况下都不许抛**。
 */
import { closeSync, openSync, readdirSync, readSync } from 'node:fs'
import { appendLogLine, cardWriteFailureCount, resetCardWriteFailureCount } from './env.js'
import {
  archivePath,
  atomicWrite,
  diaryPrivateDir,
  diaryPublicDir,
  exists,
  healthStatePath,
  notesIndexPath,
  readText
} from './paths.js'
import { normalizeConfig, ownerImportant } from './memory.js'
// 2026-11-06 P3：完整性判定改用 diary/completion.js 这个叶子模块。
// 原来从这里 import 整个 diary.js，形成 store → health → diary → store 的模块环；
// 现在 health 只依赖不碰 store 的时间/完整性工具，环断掉，依赖图门禁会强制守住。
import { diaryIsCompleteFor, todayKey } from './diary/completion.js'
import { ingestFailureCount, resetIngestFailureCount } from './extract.js'

// --------------------------------------------------------------------------
// 提炼队列计数（入队 +1、出队 -1）
// --------------------------------------------------------------------------

/**
 * 为什么不在 index.js 里读 refineChain 的「长度」：
 * Promise 链没有 length，pending 数量也拿不到。这里记一个最简单的在途计数：
 * queueRefine 同步入队时 +1，链跑完（成功/失败/降级都算）时 -1。
 * 它是进程内的，只用于健康行，不参与调度 —— 调度仍然是 refineChain 本身。
 */
let refinePending = 0

export function markRefineQueued() {
  refinePending += 1
}

export function markRefineSettled() {
  if (refinePending > 0) refinePending -= 1
}

export function refinePendingCount() {
  return refinePending
}

/** 测试用：把在途计数归零。 */
export function __resetRefinePendingForTest() {
  refinePending = 0
}

// --------------------------------------------------------------------------
// 读数
// --------------------------------------------------------------------------

/** 抛错就退回 fallback —— 只用于「明确允许缺」的读数。 */
function safe(fn, fallback = null) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * 一行日记都没写过时也要能给出「最近=-」。
 * 只看文件名（YYYY-MM-DD.md），不打开正文；public/private 取最大日期。
 */
function latestDiaryDate() {
  let latest = ''
  for (const dir of [diaryPublicDir(), diaryPrivateDir()]) {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const matched = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(String(name))
      if (matched !== null && matched[1] > latest) latest = matched[1]
    }
  }
  return latest
}

/**
 * 数 archive.jsonl 有几行。
 *
 * 约束里写明「读文件数行，不要全量解析」：这里按 64KB 块流式数换行符，
 * 不 JSON.parse、不把整文件读进内存（档案只增不减，跑久了会很大）。
 * 文件不存在 = 0 条；读不了 = null（最终写 `-`）。
 */
function countArchiveLines() {
  const file = archivePath()
  if (!exists(file)) return 0
  let fd
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let lines = 0
    let lastByte = 0x0a
    let read = 0
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      for (let i = 0; i < read; i += 1) {
        if (buffer[i] === 0x0a) lines += 1
      }
      lastByte = buffer[read - 1]
    }
    // 最后一行没换行也算一条（append 写出来的通常有，但别假定）
    if (lastByte !== 0x0a) lines += 1
    return lines
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 关不掉也不能盖住读数结果 */
      }
    }
  }
}

/**
 * 笔记篇数以 index.json 的 notes.length 为准（约束里指定的口径）。
 * 文件不存在 = 0 篇（还没写过）；存在但读坏 = null（写 `-`，别把坏索引报成 0）。
 */
function countNotes() {
  const file = notesIndexPath()
  if (!exists(file)) return 0
  const raw = readText(file)
  if (String(raw).trim() === '') return null
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed?.notes)) return null
  return parsed.notes.length
}

/** 一张记忆卡的几个数：条数 / pinned / 保护线 / 模糊 / 遗忘。 */
function metricOf(card, cfg) {
  if (card === null || card === undefined || !Array.isArray(card.records)) {
    throw new Error('记忆卡不可用')
  }
  let pinned = 0
  let protectedCount = 0
  let fuzzy = 0
  for (const record of card.records) {
    if (record?.pinned === true) pinned += 1
    // 保护线：跟衰减/压缩用的是同一个判据（memory.js 的 ownerImportant），
    // 不能在这里另写一套「看起来差不多」的规则。
    if (ownerImportant(record, cfg)) protectedCount += 1
    // 「模糊」= clear 以下、但还没进 forgotten 的两档（fuzzy / trace）。
    // forgotten 单独一列，避免同一批记录被数两遍。
    if (record?.clarity === 'fuzzy' || record?.clarity === 'trace') fuzzy += 1
  }
  return {
    count: card.records.length,
    pinned,
    protected: protectedCount,
    fuzzy,
    forgotten: Number(card.stats?.forgotten) || 0
  }
}

function zeroMetric() {
  return { count: 0, pinned: 0, protected: 0, fuzzy: 0, forgotten: 0 }
}

/** 日记那一段：最近一天 + 完整/缺/未绑。 */
function diaryMetric(cfg) {
  const bound = String(cfg?.diarySessionId ?? '').trim() !== ''
  const date = latestDiaryDate()
  if (!bound) return { date: date === '' ? '-' : date, state: '未绑' }
  if (date === '') return { date: '-', state: '缺' }
  return { date, state: diaryIsCompleteFor(date) ? '完整' : '缺' }
}

/** 把各项数字拼成一行。任何一项抛错都只影响那一项。 */
export function renderHealthLine({ cwd = '', config = {}, cards = {}, now = Date.now() } = {}) {
  const cfg = safe(() => normalizeConfig(config), {})

  // ---- 记忆（项目 / 全局）----
  const projectMetric = String(cwd ?? '').trim() === ''
    ? zeroMetric()
    : safe(() => metricOf(cards.project, cfg), null)
  const globalMetric = safe(() => metricOf(cards.global, cfg), null)

  let memoryBlock = '记忆 -'
  if (projectMetric !== null && globalMetric !== null) {
    const sum = (key) => projectMetric[key] + globalMetric[key]
    memoryBlock = `记忆 项目=${projectMetric.count} 全局=${globalMetric.count}`
      + `（pinned ${sum('pinned')} / 保护 ${sum('protected')} / 模糊 ${sum('fuzzy')} / 遗忘 ${sum('forgotten')}）`
  }

  const archiveLines = safe(() => countArchiveLines(), null)
  const noteCount = safe(() => countNotes(), null)
  const diary = safe(() => diaryMetric(cfg), null)
  const writeFailures = safe(() => ingestFailureCount() + cardWriteFailureCount(), null)
  const refineQueue = safe(() => refinePendingCount(), null)

  return '[health] ' + [
    memoryBlock,
    `归档 ${archiveLines === null ? '-' : archiveLines} 条`,
    `笔记 ${noteCount === null ? '-' : noteCount} 篇`,
    diary === null
      ? '日记 最近=- 公开/私密=-'
      : `日记 最近=${diary.date} 公开/私密=${diary.state}`,
    `写盘失败 ${writeFailures === null ? '-' : writeFailures}`,
    `提炼队列 ${refineQueue === null ? '-' : refineQueue}`
  ].join('｜')
}

// --------------------------------------------------------------------------
// 状态文件：一天只写一行
// --------------------------------------------------------------------------

function readLastHealthDate() {
  try {
    const raw = readText(healthStatePath())
    if (String(raw).trim() === '') return ''
    const parsed = JSON.parse(raw)
    return typeof parsed?.lastDate === 'string' ? parsed.lastDate : ''
  } catch {
    // 状态文件坏了就当没写过：宁可多一行，也不要整天不写。
    return ''
  }
}

function saveLastHealthDate(date) {
  try {
    const saved = atomicWrite(healthStatePath(), `${JSON.stringify({ lastDate: date })}\n`)
    return saved?.ok === true
  } catch {
    return false
  }
}

/**
 * 每天写一行健康指标。挂在 maintain 末尾调用。
 *
 * @param {{cwd?: string, config?: object, cards?: {global?: object, project?: object|null}, now?: number}} input
 * @returns {{written: boolean, date: string, line: string}} 只给测试和日志用，调用方不该依赖它
 */
export function writeDailyHealth({ cwd = '', config = {}, cards = {}, now = Date.now() } = {}) {
  let date = ''
  try {
    date = todayKey(now)
    if (readLastHealthDate() === date) return { written: false, date, line: '' }

    const line = renderHealthLine({ cwd, config, cards, now })
    // 先写日志再落状态：日志写不进去就保持「今天还没写」，下一次 maintain 会重试。
    // 反过来先落状态的话，一次写日志失败就等于这一天永远没有健康行。
    if (appendLogLine(line) !== true) return { written: false, date, line }

    saveLastHealthDate(date)
    // 写成功才清零：这一行里的「写盘失败」是当天累计，第二天从 0 重新数。
    safe(() => resetIngestFailureCount())
    safe(() => resetCardWriteFailureCount())
    return { written: true, date, line }
  } catch (error) {
    // 兜底：连拼行都炸了也不许抛（它在注入路径上）。往 stderr 留一句，不写日志
    // ——日志本身可能正是坏掉的那一环。
    try {
      process.stderr.write(`[soul] 每日健康行写入失败：${error instanceof Error ? error.message : error}\n`)
    } catch {
      /* stderr 也没了就真没办法了 */
    }
    return { written: false, date, line: '' }
  }
}
