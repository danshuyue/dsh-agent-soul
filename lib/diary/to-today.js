/**
 * to-today.js —— 「昨天想对今天说的话」（2026-11-09 R19 / ⑥）。
 *
 * ── 它是什么 ──
 *   每天写完**私密日记之后**，她可以在正文末尾多写一行（固定前缀）：
 *   一句写给明天的自己、也愿意让对方看到的话。范例：「明天试着把"不吵"换成"我在"」。
 *
 * ── 为什么不是再调一次模型 ──
 *   「顺手」就该是顺手：搭私密篇那一次产出的末班车，**每天零新增调用**。
 *   没写 / 前缀缺失 / 超长 → 今天就没有这句，不重试、不兜底、不告警（拒绝不是失败）。
 *
 * ── 为什么不改写私密正文 ──
 *   设计稿原本打算把这一行从私密 md 里剥掉再单独存。但 scheduler 在私密落盘后**本来就会
 *   把正文读回来**（给连续线用），所以这里只需要**解析**、不需要**改写**：
 *   那行话留在她自己的日记里，程序一次都不碰正文 —— 「从不改写」比「剥完逐字节一致」更强。
 *
 * ── 生命周期 ──
 *   单条、按天覆盖；`date` 是这句话**面向的那一天**（写日记时的「今天」）。
 *   跨天作废，不累积、不做历史列表、不进记忆卡、不进人格文件、不参与任何统计。
 */
import { atomicWrite, diaryToTodayPath, readText } from '../paths.js'

/** 私密正文里用来标记这一行的前缀。改它会让旧日记里的那句失效（可接受）。 */
export const TO_TODAY_MARK = '想对明天说：'

const DEFAULT_MAX_CHARS = 30

/**
 * 从一篇私密日记里解析出那句话。
 * @param {string} text 私密正文
 * @returns {string} 没写 / 不合规 → ''
 */
export function parseToToday(text) {
  const body = String(text ?? '')
  if (body === '') return ''
  const lines = body.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (line === '') continue
    // 允许 markdown 引用/列表前缀，用户手写时不至于认不出
    const cleaned = line.replace(/^[>\-*+\s]+/, '').trim()
    const at = cleaned.indexOf(TO_TODAY_MARK)
    if (at === -1) continue
    return cleaned.slice(at + TO_TODAY_MARK.length).trim()
  }
  return ''
}

/**
 * 校验并收窄那句话（这是「别让她写成周报」的最后一道闸，不是文案规则的全部）。
 * @param {string} raw
 * @param {number} maxChars
 * @returns {{ok:boolean, text?:string, reason?:string}}
 */
export function normalizeToToday(raw, maxChars = DEFAULT_MAX_CHARS) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return { ok: false, reason: '空' }
  const limit = Math.max(10, Math.min(60, Math.trunc(Number(maxChars) || DEFAULT_MAX_CHARS)))
  if (text.length > limit) return { ok: false, reason: `超过 ${limit} 字` }
  return { ok: true, text }
}

/**
 * 写一条（按天覆盖）。dateStr 是这句话**面向的那一天**。
 * @returns {{ok:boolean, error?:string}}
 */
export function saveToToday(dateStr, text, { source = 'private-diary', editedByUser = false } = {}) {
  const date = String(dateStr ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: '日期不合法' }
  const body = {
    date,
    text: String(text ?? '').trim(),
    source,
    shared: true,
    createdAt: new Date().toISOString(),
    editedByUser: editedByUser === true
  }
  if (body.text === '') return { ok: false, error: '正文不能空' }
  return atomicWrite(diaryToTodayPath(), `${JSON.stringify(body, null, 2)}\n`)
}

/**
 * 读今天的（严格按 date 匹配：昨天的自动作废，不用额外清理）。
 * 文件坏 / 缺字段 → null，不抛错。
 */
export function readToToday(dateStr) {
  try {
    const raw = JSON.parse(readText(diaryToTodayPath()))
    if (raw === null || typeof raw !== 'object') return null
    if (String(raw.date ?? '') !== String(dateStr ?? '')) return null
    const text = String(raw.text ?? '').trim()
    if (text === '') return null
    return {
      date: String(raw.date),
      text,
      source: String(raw.source ?? ''),
      createdAt: String(raw.createdAt ?? ''),
      editedByUser: raw.editedByUser === true
    }
  } catch {
    return null
  }
}

/** 删掉（当天立刻没有这句）。 */
export function clearToToday() {
  return atomicWrite(diaryToTodayPath(), '')
}
