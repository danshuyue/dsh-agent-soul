/**
 * 日记时间工具与完整性判定（2026-11-06 P3 从 lib/diary.js 抽出）。
 *
 * 抽它的原因：health.js 只需要 diaryIsCompleteFor / todayKey，却因此 import 了
 * 整个 diary.js，形成 store → health → diary → store 的模块环。这组函数只依赖
 * node:fs 与 paths.js，抽成叶子模块后 health.js 直接依赖它，环消失。
 * 函数体保持原样，行为零变化。
 */
import { readFileSync, statSync } from 'node:fs'
import { note } from '../env.js'
import {
  diaryJsonlPath,
  diaryPrivatePath,
  diaryPublicPath,
  exists,
  isDiaryDateKey
} from '../paths.js'


// --------------------------------------------------------------------------
// 时间工具
// --------------------------------------------------------------------------

/** 本地日期键 YYYY-MM-DD。 */
export function todayKey(at = Date.now()) {
  const d = new Date(Number(at) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}


/**
 * 昨天的日期键。
 *
 * 2026-10-31：日记改成「第二天写前一天的」。当天写只写得到半天，
 * 隔一天写，昨天的 00:00–24:00 窗口已经完整闭合。
 * 用 setDate 减一天，跨月、跨年由 Date 自己处理，不用手算。
 */
export function yesterdayKey(at = Date.now()) {
  const d = new Date(Number(at) || Date.now())
  d.setDate(d.getDate() - 1)
  return todayKey(d.getTime())
}


/** 把 'YYYY-MM-DD' 解析成本地零点的 Date（不用 new Date(str) 避免 UTC 歧义）。 */
export function parseDateLocal(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? '').trim())
  if (m === null) return new Date(NaN)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0)
}


/** 'HH:MM' → 当日分钟数；格式不对回退默认值。 */
export function scheduleMinutes(hhmm, fallback = 22 * 60) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (m === null) return fallback
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 24 || mi > 59) return fallback
  return (h % 24) * 60 + mi
}


/**
 * 日记日的边界（2026-10-31 改：自然日）。
 *
 * 日记「2026-10-31」= 2026-10-31 00:00 ~ 2026-11-01 00:00。
 *
 * 原来按 schedule 分界（默认 22:00），覆盖的是「前一天 22:00 ~ 当天 22:00」。
 * 那是给「当晚十点写日记」设计的：晚上十点时「今天」在感受上还没结束。
 * 但现在已经改成「第二天写前一天」，那个理由不成立了 —— 隔一天再写，
 * 昨天一整天已经完整闭合，用自然日最直观：写的是哪一天，就是哪一天。
 *
 * ⚠️ 注意不能靠「把 scheduleMin 传 0」来实现自然日：
 * 旧公式是 `dayStart - 24h + sm`，传 0 会算成「前一天 00:00 ~ 当天 00:00」，
 * 也就是写成了前一天的日记。这里直接把公式改成自然日，参数只为兼容保留。
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @returns {{start: number, end: number}} 毫秒时间戳，左闭右开
 */
export function diaryDayBoundaries(dateStr, _scheduleMin) {
  const dayStart = parseDateLocal(dateStr).getTime()
  if (Number.isNaN(dayStart)) return { start: 0, end: 0 }
  return { start: dayStart, end: dayStart + 24 * 60 * 60 * 1000 }
}


/**
 * 某天的两篇日记是不是「完整写过」（2026-11-01 补）。
 *
 * 只看文件存在是不够的 —— 这是真踩过的坑：
 * 10-31 下午 14:20 手动触发写过那一篇，可当时窗口（到当天 24:00）还没闭合，
 * 只写得到半天。第二天开机看到两个文件都在，就当成已完成跳过了，
 * 结果下午到晚上那一大段（改压缩配置、推 GitHub、发 npm）**全丢了**。
 *
 * 所以判据要加上时间：两篇的最后修改时间都必须**在窗口闭合之后**
 * （也就是次日 00:00 之后），才算这一天真的写完了。
 * 在闭合前写的 = 只写了半天，第二天应该重写。
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @returns {boolean} true = 完整写过，可以跳过
 */
export function diaryIsCompleteFor(dateStr) {
  // 2026-11-05：S1 给路径函数加了日期白名单（会抛 TypeError），
  // 这里是个查询语义，非法日期应当安静地返回「不完整」而不是炸。
  // 这条是 diary-complete.test.js 挂进 npm test 后才暴露的回归。
  if (!isDiaryDateKey(dateStr)) return false
  const pub = diaryPublicPath(dateStr)
  const priv = diaryPrivatePath(dateStr)
  if (!exists(pub) || !exists(priv)) return false
  const { start, end } = diaryDayBoundaries(dateStr, 0)
  if (!Number.isFinite(end) || end <= 0) return false

  let written = 0
  try {
    // 两篇里**先写的那篇**才算数：一篇早上写、一篇晚上写，早的那篇仍然只有半天
    written = Math.min(statSync(pub).mtimeMs, statSync(priv).mtimeMs)
  } catch {
    return false
  }
  if (written >= end) return true // 过了零点才写：必然覆盖完整一天

  // 2026-11-01 补：**没熬过零点，不代表只写了半天。**
  //
  // 上面那条"必须在窗口闭合之后"太粗了。实测踩到：10-30 那篇写于 22:00，
  // 而那一天最后一条对话是 20:39 —— 内容其实已经写全了，
  // 可判据只看"mtime 有没有过 00:00"，于是下一次开机会把它**白重写一遍**。
  //
  // 所以补一条更贴事实的：写完那一刻之后，这一天里**再没有新的对话**，就算完整。
  // 反过来，22:00 写完、23:30 又聊了，那才是真的漏了（重写是对的）。
  //
  // 判不准的时候站哪边：站"不完整"。漏写一天是丢内容，白重写一天只是多花一次调用 ——
  // 所以拿不到对话流水时，退回到上面那条严格判据，而不是乐观点放过。
  // （真没流水也补不出东西：findMissingDay 本来就要求那天有 JSONL。）
  const lastTalk = lastTalkAtOf(dateStr, start, end)
  if (lastTalk <= 0) return written >= end
  return written >= lastTalk
}


/** 那一天里最后一条对话的时间戳（只看当天；读不到返回 0）。 */
function lastTalkAtOf(dateStr, start, end) {
  try {
    const file = diaryJsonlPath(dateStr)
    if (!exists(file)) return 0
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n')
    // 2026-11-07 R05 / P1-D4：**整份扫**，不再只看末尾 80 行。
    //
    // 原来的理由是「文件是追加写的，最后一条就在末尾附近」。但 feed.js 自己写着
    // 落盘顺序 ≠ 发生顺序（多会话交错 + late flush）——一次交错，最后那句就被挤出
    // 末尾 80 行，lastTalk 被低估 → 半天版被判「完整」→ 永不重写 → 那段永久丢失。
    // 而且文件**已经整份读进内存了**，只遍历尾部的 80 行并不省 IO，纯粹是遗留写法。
    //
    // 成本：一天几千行 JSON.parse，只在启动/看门狗里跑，不在每轮热路径。
    // 兜底：行数异常大时只扫后半（宁可保守判「不完整」，也不要卡住看门狗）。
    const MAX_LINES = 50_000
    const from = lines.length > MAX_LINES ? Math.floor(lines.length / 2) : 0
    if (from > 0) note('diary', `${dateStr} 的对话记录有 ${lines.length} 行，只扫后半段判最后说话时间`)
    let latest = 0
    for (let i = from; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (line === '') continue
      try {
        const t = Number(JSON.parse(line)?.t)
        if (Number.isFinite(t) && t >= start && t < end && t > latest) latest = t
      } catch { /* 坏行跳过 */ }
    }
    return latest
  } catch {
    return 0
  }
}
