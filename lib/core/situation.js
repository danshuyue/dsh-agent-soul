/**
 * situation.js —— 现实情境感知（2026-11-09 R19 / ④）。
 *
 * ── 为什么 ──
 *   现在时间只有「自然日」一个刻度（开机补昨天、看门狗 30 分钟）。
 *   时段（深夜 / 清晨）、节日、久未交互、季节都是**纯规则、零模型成本**的信号，
 *   喂给日记与目的就能明显提升沉浸感 —— 这是四件事里最便宜的。
 *
 * ── 纪律 ──
 *   · **不进系统提示词的主干**：只作为日记素材、⑥ 那句话的背景、目的地一句状态；
 *     把时段塞进主干会让每轮上下文随时间抖动，长缓存全废（心情语气那节已经踩过）。
 *   · **不落状态域**：纯计算，每次要用时现算；节日表可编辑（`agents/situation.json`），
 *     读不到就用内置默认，不抛错。
 *   · **v1 只做公历固定日期**：春节/中秋要农历，引日历库会破坏零依赖，标 v2。
 *   · `core/` 只允许依赖 `core/` 与 `paths.js`（见 tests/contract/dep-graph.test.js）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { diaryConversationsDir, situationHolidaysPath } from '../paths.js'

const DAY_MS = 86_400_000

/** 内置节日（公历固定日期）。用户可用 agents/situation.json 覆盖。 */
export const DEFAULT_HOLIDAYS = Object.freeze({
  '01-01': '元旦',
  '02-14': '情人节',
  '05-01': '劳动节',
  '06-01': '儿童节',
  '10-01': '国庆',
  '12-24': '平安夜',
  '12-25': '圣诞节',
  '12-31': '跨年夜'
})

/** 时段（按本地小时）。刻意不做「早上/中午」这种太细的切分：日记里用不到。 */
export function periodOf(hour) {
  const h = Number(hour)
  if (!Number.isFinite(h)) return 'day'
  if (h >= 0 && h < 5) return 'late-night'
  if (h >= 5 && h < 8) return 'early-morning'
  if (h >= 8 && h < 12) return 'morning'
  if (h >= 12 && h < 18) return 'afternoon'
  if (h >= 18 && h < 23) return 'evening'
  return 'late-night'
}

const PERIOD_LABEL = Object.freeze({
  'late-night': '深夜',
  'early-morning': '清晨',
  morning: '上午',
  afternoon: '下午',
  evening: '晚上',
  day: ''
})

/** 季节按公历月份（北半球口径）。 */
export function seasonOf(month) {
  const m = Number(month)
  if (!Number.isFinite(m)) return ''
  if (m >= 3 && m <= 5) return '春'
  if (m >= 6 && m <= 8) return '夏'
  if (m >= 9 && m <= 11) return '秋'
  return '冬'
}

/**
 * 读节日表。文件不存在 / 坏掉 → 用内置默认（不抛错，不写盘）。
 * @returns {Record<string,string>}
 */
export function loadHolidays() {
  try {
    const file = situationHolidaysPath()
    if (!existsSync(file)) return { ...DEFAULT_HOLIDAYS }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    // 只收 "MM-DD": "名字" 形状，其它键忽略 —— 手改坏了不该让日记整篇没有素材
    const out = {}
    for (const [key, value] of Object.entries(raw ?? {})) {
      if (!/^\d{2}-\d{2}$/.test(key)) continue
      const name = String(value ?? '').trim()
      if (name !== '') out[key] = name.slice(0, 12)
    }
    return Object.keys(out).length > 0 ? out : { ...DEFAULT_HOLIDAYS }
  } catch {
    return { ...DEFAULT_HOLIDAYS }
  }
}

/**
 * 距上次对话多少天 —— **只看文件名**，不读内容（便宜到可以每步调）。
 *
 * 判据：`agents/conversations/<YYYY-MM-DD>.jsonl` 里今天有没有；没有就找最近的一天。
 * 60 秒缓存：每步都 readdir 没必要，而「久未交互」本来是个以天为单位的概念。
 */
let lastChatCache = { at: 0, days: 0 }

export function daysSinceLastChat(now = Date.now()) {
  const ms = Number(now) || Date.now()
  if (lastChatCache.at > 0 && ms - lastChatCache.at < 60_000) {
    // 缓存里存的是「当时算出来的天数」，隔 60 秒复用不会失真到天
    return lastChatCache.days
  }
  let days = 0
  try {
    const dir = diaryConversationsDir()
    if (existsSync(dir)) {
      const today = dayKeyOf(ms)
      const names = readdirSync(dir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .map((name) => name.slice(0, 10))
        .sort()
      if (names.length > 0 && names[names.length - 1] !== today) {
        const last = Date.parse(`${names[names.length - 1]}T00:00:00Z`)
        const nowDay = Date.parse(`${today}T00:00:00Z`)
        const gap = Math.floor((nowDay - last) / DAY_MS)
        if (Number.isFinite(gap) && gap > 0) days = gap
      }
    }
  } catch {
    days = 0
  }
  lastChatCache = { at: ms, days }
  return days
}

/** 测试用：清掉 60 秒缓存。 */
export function __resetSituationCacheForTest() {
  lastChatCache = { at: 0, days: 0 }
}

/** 本地日期键（YYYY-MM-DD）。与 diary/completion.js 的 todayKey 同口径，这里不引它以免 core→business。 */
export function dayKeyOf(ms) {
  const d = new Date(Number(ms) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 算一次情境。
 *
 * @param {number} [now]
 * @param {{ holidays?: Record<string,string>, lastChatAt?: number }} [options]
 *   lastChatAt 由调用方查（本模块不读对话流水，保持纯计算）
 * @returns {{period:string, periodLabel:string, holiday:string, season:string,
 *            month:number, day:number, daysSinceLastChat:number,
 *            tags:string[], facts:string[] }}
 */
export function situationOf(now = Date.now(), { holidays, lastChatAt = 0, daysAgo = 0, withPeriod = true } = {}) {
  const table = holidays ?? loadHolidays()
  const d = new Date(Number(now) || Date.now())
  const month = d.getMonth() + 1
  const day = d.getDate()
  const key = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const period = withPeriod === false ? '' : periodOf(d.getHours())
  const periodLabel = PERIOD_LABEL[period] ?? ''
  const holiday = String(table[key] ?? '')
  const season = seasonOf(month)

  let daysSinceLastChat = Math.max(0, Math.trunc(Number(daysAgo) || 0))
  const last = Number(lastChatAt) || 0
  if (daysSinceLastChat === 0 && last > 0) {
    const gap = Math.floor((Number(now) - last) / DAY_MS)
    if (Number.isFinite(gap) && gap > 0) daysSinceLastChat = gap
  }

  const tags = [period, `month:${month}`, `season:${season}`]
  const facts = []
  if (periodLabel !== '') facts.push(`现在是${periodLabel}`)
  facts.push(`${month} 月·${season}`)
  if (holiday !== '') facts.push(`今天是${holiday}`)
  if (daysSinceLastChat >= 2) facts.push(`已经 ${daysSinceLastChat} 天没聊过了`)
  if (holiday !== '') tags.push(`holiday:${holiday}`)
  if (daysSinceLastChat >= 2) tags.push(`long-absence:${daysSinceLastChat}`)

  return { period, periodLabel, holiday, season, month, day, daysSinceLastChat, tags, facts }
}

/**
 * 目的地那一句（很短，一句话进「此刻状态」）。
 * 空配置 / 无话可说时返回 '' —— 逐字节等价靠这个空分支。
 */
export function briefOf(situation) {
  const facts = Array.isArray(situation?.facts) ? situation.facts : []
  // 长缺席与节日比「上午/下午」更值得说，优先取它们
  const picked = []
  const holiday = facts.find((f) => f.startsWith('今天是'))
  const absence = facts.find((f) => f.startsWith('已经'))
  const period = facts.find((f) => f.startsWith('现在是'))
  if (absence !== undefined) picked.push(absence)
  if (holiday !== undefined) picked.push(holiday)
  if (period !== undefined && picked.length < 2) picked.push(period)
  return picked.join('，')
}

/**
 * 日记素材里的背景事实（喂给 composeDiaryText 的 prompt）。
 * 只给**事实**，不给「你要写得温暖一点」这类指令 —— 一让她照着情绪演，日记就假了。
 */
export function diaryFactsOf(situation) {
  const facts = Array.isArray(situation?.facts) ? situation.facts : []
  return facts.filter((f) => f !== '')
}
