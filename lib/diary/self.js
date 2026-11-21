/**
 * 心里话 · self.js（2026-11-21 / 0.10.2）。
 *
 * ── 它是什么 ──
 *   和摘录（excerpt）是两件东西：
 *     摘录   = 一天的事实条目，插件让她用 soul_diary 写，没写成插件兜底；
 *     心里话 = 她自己那天怎么想的，**她自己用写文件工具落盘**，插件只读、不解析她的回复。
 *
 * ── 存储（设计文档 §3，A 方案）──
 *   `agents/diary/self/YYYY-MM.md`，按月一个文件：
 *
 *     # 2026-11
 *
 *     ## 2026-11-20
 *     今天……
 *
 *     ## 2026-11-19
 *     ……
 *
 *   新的一天加在最上面；正文自由写，无字数上限。
 *   按月而不是按天：她用普通写文件工具（覆盖式），文件越小、改动越局部，越不容易改坏。
 *
 * ── 触发 ──
 *   每天 6:00 之后第一次检查：昨天还没有 `## 日期` 小节 → 投一句很短的提醒，
 *   只给日期、绝对路径、格式，**不投递任何对话文本**（让她凭那个会话里的上文回忆）。
 *   会话不可用 / 她没写 → 日志一行「昨天没有心里话」，不重试、不催、不替她写。
 *
 * ── 插件唯一写盘的路径 ──
 *   设置页的手动重写（`writeSelfEntry`，走 POST /self/save）—— 那是人改的。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { atomicWrite, diarySelfDir, diarySelfMonthPath, diarySelfPath, exists, isDiaryDateKey } from '../paths.js'
import { note } from '../env.js'
import { loadConfig } from '../store.js'
import { parseDateLocal, todayKey, yesterdayKey } from './completion.js'
import { briefOf, daysSinceLastChat, situationOf } from '../core/situation.js'
import { selfAgent } from './agent.js'
import { sendAgentMessage } from './deliver.js'

/** 6 点之前不触发（设计文档 §1：每天 6:00 之后第一次检查）。 */
export const SELF_START_HOUR = 6

/** 投递后等她落盘多久（毫秒）。她只写一小段，给 90 秒；等不到只记日志，不重试。 */
export const SELF_WAIT_MS = 90_000

/** 看门狗滴答：每分钟看一眼，6 点前直接返回，几乎不花钱。 */
const SELF_TICK_MS = 60_000

/** 判断「现在到 6 点没有」。抽成纯函数，测试和毒化都盯这一条。 */
export function selfDue(at = Date.now()) {
  const d = new Date(Number(at) || Date.now())
  return d.getHours() >= SELF_START_HOUR
}

/** 日期 → 所属月份 `YYYY-MM`。 */
export function selfMonthKeyOf(dateStr) {
  return String(dateStr ?? '').slice(0, 7)
}

/**
 * 解析一个月的心里话文件，返回 `Map<日期, 正文>`。
 *
 * 只认 `## YYYY-MM-DD` 这一种小节标题（前后空白允许）。`# 2026-11` 是文件头，忽略；
 * 小节正文到下一个 `##` 标题为止。正文里的普通 `#` 标题不会被当成小节。
 */
export function parseSelfSections(text) {
  const out = new Map()
  let current = null
  let body = []
  const flush = () => {
    if (current !== null) out.set(current, body.join('\n').trim())
    body = []
  }
  for (const rawLine of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const matched = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(rawLine.trim())
    if (matched !== null) {
      flush()
      current = matched[1]
      continue
    }
    if (current !== null) body.push(rawLine)
  }
  flush()
  return out
}

/** 读某个月的心里话原文（文件不在 → 空串）。 */
function readSelfMonthFile(monthKey) {
  try {
    const file = diarySelfMonthPath(monthKey)
    return exists(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

/** 某一天的心里话正文；没有小节 / 小节是空的 → 空串。 */
export function readSelfEntry(dateStr) {
  if (!isDiaryDateKey(dateStr)) return ''
  const sections = parseSelfSections(readSelfMonthFile(selfMonthKeyOf(dateStr)))
  return sections.get(dateStr) ?? ''
}

/** 昨天有没有心里话（证据 / 触发判定用）。 */
export function hasSelfEntry(dateStr) {
  return readSelfEntry(dateStr).trim() !== ''
}

/**
 * 最近 N 天（含今天）的心里话。
 * @returns {Array<{date: string, hasText: boolean, text: string}>} 从新到旧
 */
export function listSelfEntries(days = 14, now = Date.now()) {
  const count = Math.max(1, Math.trunc(Number(days) || 14))
  const out = []
  const base = new Date(Number(now) || Date.now())
  base.setHours(0, 0, 0, 0)
  for (let i = 0; i < count; i += 1) {
    const date = todayKey(base.getTime() - i * 24 * 60 * 60 * 1000)
    const text = readSelfEntry(date)
    out.push({ date, hasText: text.trim() !== '', text })
  }
  return out
}

/** 最近 N 天里真的有正文的那些（注入用，从新到旧）。 */
export function readRecentSelfEntries(days = 3, now = Date.now()) {
  return listSelfEntries(days, now).filter((item) => item.hasText)
}

/**
 * 手动写 / 删某一天的心里话（**插件唯一写心里话的路径**，设置页的人改的）。
 *
 * text 为空 = 删掉该小节。写的时候整月重建：文件头 + 所有小节按日期从新到旧排列，
 * 这样「新的一天加在最上面」不是靠她或用户自觉，而是落盘时就算好了。
 *
 * @returns {{ok: true, date: string, hasText: boolean} | {ok: false, error: string}}
 */
export function writeSelfEntry(dateStr, text) {
  if (!isDiaryDateKey(dateStr)) return { ok: false, error: '日期必须是 YYYY-MM-DD' }
  const monthKey = selfMonthKeyOf(dateStr)
  const body = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  try {
    mkdirSync(diarySelfDir(), { recursive: true })
    const sections = parseSelfSections(readSelfMonthFile(monthKey))
    if (body === '') sections.delete(dateStr)
    else sections.set(dateStr, body)
    const ordered = [...sections.keys()].sort().reverse()
    const chunks = [`# ${monthKey}`]
    for (const date of ordered) {
      const sectionBody = sections.get(date) ?? ''
      chunks.push('', `## ${date}`, '', sectionBody)
    }
    const written = atomicWrite(diarySelfMonthPath(monthKey), `${chunks.join('\n')}\n`)
    if (written?.ok !== true) return { ok: false, error: written?.error ?? '写盘失败' }
    return { ok: true, date: dateStr, hasText: body !== '' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 注入用截断：压成一行，超过上限就截（只影响注入，不动文件）。 */
export function clipSelfText(text, maxChars = 400) {
  const limit = Math.max(1, Math.trunc(Number(maxChars) || 400))
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * 「最近几次心里话」注入段（只读她写的文件，不调模型）。
 *
 * @param {object} cfg loadConfig() 的结果
 * @param {number} [now]
 * @returns {string} 空串 = 最近几天一条也没有
 */
export function renderSelfSection(cfg, now = Date.now()) {
  if (cfg?.selfEnabled === false) return ''
  const days = Math.max(1, Math.min(14, Math.trunc(Number(cfg?.selfInjectDays) || 3)))
  const chars = Math.max(100, Math.min(2000, Math.trunc(Number(cfg?.selfInjectChars) || 400)))
  const rows = readRecentSelfEntries(days, now)
  if (rows.length === 0) return ''
  const lines = rows.map((item) => `${item.date}：${clipSelfText(item.text, chars)}`)
  return `### 最近几次心里话\n\n${lines.join('\n')}`
}

/**
 * 组装发给她的那一小段（2026-11-21 / 0.10.2）。
 *
 * 刻意**短**：只给日期、绝对路径、小节格式。不投对话全文 —— 她在那个会话里有上文，
 * 让她自己回忆；塞进来反而会把「回忆」变成「照着素材改写」。
 * 现实情境最多一行（节日 / 久未聊），selfTone 非空时再加一行语气。
 */
export function composeSelfMessage(config, dateStr, monthFile) {
  const cfg = config ?? {}
  const target = String(monthFile ?? diarySelfPath(dateStr))
  const lines = []
  lines.push(`早。给 \`${dateStr}\` 写一段你自己那天怎么想的，写进 \`${target}\`。`)
  lines.push(`一天一个小节，写成 \`## ${dateStr}\`，新的一天加在文件最上面。写完不用回我。`)

  if (cfg.situationEnabled !== false) {
    const brief = briefOf(situationOf(parseDateLocal(dateStr).getTime(), {
      daysAgo: daysSinceLastChat(),
      withPeriod: false
    }))
    if (brief !== '') lines.push(`（背景：${brief}。）`)
  }
  const tone = String(cfg.selfTone ?? '').trim()
  if (tone !== '') lines.push(`语气：${tone}`)

  return lines.join('\n')
}

/** 轮询等某一天的小节出现（不靠 mtime：那个月文件通常早就存在）。 */
async function waitForSelfEntry(dateStr, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Math.trunc(Number(timeoutMs) || 0))
  while (true) {
    if (hasSelfEntry(dateStr)) return true
    if (Date.now() >= deadline) return false
    // 刻意**不 unref**：这是「等 100ms 再查一次」的短轮询。unref 之后，
    // 当整个进程只剩这一个待处理项时（单测、或启动早期），事件循环会直接退出，
    // await 永远等不到 —— 表现是「未 settle 的 top-level await」。
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * 执行一次「请她写昨天的心里话」。
 *
 * 不负责 6 点门槛（那是 maybeRunSelfAt / 看门狗的事）；调用方已经确认「该跑了」。
 *
 * @param {object} ctx
 * @param {{ now?: number, dateStr?: string, waitMs?: number, config?: object }} [options]
 * @returns {Promise<{ok: boolean, wrote: boolean, reason: string}>}
 */
export async function runSelfOnce(ctx, options = {}) {
  const now = Number(options.now) || Date.now()
  const config = options.config ?? loadConfig()
  if (config.selfEnabled === false) return { ok: false, wrote: false, reason: 'disabled' }

  const dateStr = String(options.dateStr ?? '').trim() || yesterdayKey(now)
  if (!isDiaryDateKey(dateStr)) return { ok: false, wrote: false, reason: `非法日期：${dateStr}` }
  if (hasSelfEntry(dateStr)) {
    note('self', `${dateStr} 的心里话已经写了，跳过`)
    return { ok: true, wrote: true, reason: 'already' }
  }

  const monthFile = diarySelfPath(dateStr)
  const agent = await selfAgent(ctx)
  if (agent === undefined || agent === null) {
    note('self', `昨天没有心里话（${dateStr}）：没有可用的会话，不重试、不催、不替她写`)
    return { ok: false, wrote: false, reason: 'no-agent' }
  }

  const message = composeSelfMessage(config, dateStr, monthFile)
  const sent = sendAgentMessage(ctx, agent, message)
  if (!sent.ok) {
    note('self', `昨天没有心里话（${dateStr}）：投递失败（${sent.reason}），不重试`)
    return { ok: false, wrote: false, reason: 'send-failed' }
  }
  note('self', `已请她写 ${dateStr} 的心里话（${monthFile}）`)

  const waitMs = options.waitMs === undefined ? SELF_WAIT_MS : Math.max(0, Math.trunc(Number(options.waitMs) || 0))
  const wrote = await waitForSelfEntry(dateStr, waitMs)
  if (!wrote) {
    note('self', `昨天没有心里话（${dateStr}）：她没写，不重试、不催、不替她写`)
    return { ok: true, wrote: false, reason: 'missing' }
  }
  note('self', `${dateStr} 的心里话已落盘`)
  return { ok: true, wrote: true, reason: 'written' }
}

/**
 * 6 点门槛 + 跑一次（看门狗和测试都走这里）。
 * 门槛单独放在这里，是为了让「0 点也投」这种回退能在一个纯函数上被测出来。
 */
export async function maybeRunSelfAt(ctx, now = Date.now(), options = {}) {
  if (!selfDue(now)) return { ok: false, wrote: false, reason: 'before-6' }
  return runSelfOnce(ctx, { ...options, now })
}

/**
 * 启动心里话的定时链路（2026-11-21 / 0.10.2）。
 *
 * 和摘录同一套形状：启动后 +5 秒跑一次，之后每分钟滴答（6 点前直接返回）。
 * 每天只尝试一次：试过之后（不管她写没写）当天不再投 —— 不重试、不催。
 */
export function startSelfTimer(ctx) {
  let stopped = false
  let inFlight = false
  let lastAttemptDate = ''

  const work = async () => {
    if (stopped || inFlight) return
    const now = Date.now()
    if (!selfDue(now)) return
    const dateStr = yesterdayKey(now)
    if (lastAttemptDate === dateStr) return
    // 已经写了：记一笔，今天不再看
    if (hasSelfEntry(dateStr)) {
      lastAttemptDate = dateStr
      return
    }
    inFlight = true
    try {
      lastAttemptDate = dateStr
      await maybeRunSelfAt(ctx, now)
    } catch (error) {
      note('self', `心里话流程失败：${error instanceof Error ? error.message : error}`)
    } finally {
      inFlight = false
    }
  }

  const startupTimer = setTimeout(() => { void work() }, 5000)
  if (startupTimer !== null && typeof startupTimer.unref === 'function') startupTimer.unref()
  const watchdogTimer = setInterval(() => { void work() }, SELF_TICK_MS)
  if (watchdogTimer !== null && typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
  note('self', '心里话定时器已启动（6:00 之后第一次检查；每天只尝试一次）')

  return () => {
    stopped = true
    if (startupTimer !== null) clearTimeout(startupTimer)
    if (watchdogTimer !== null) clearInterval(watchdogTimer)
  }
}
