/**
 * session-groups.js —— 把对话流水按「工作区 → 会话 → 时间」分组（2026-11-08）。
 *
 * 起因：conversations/*.jsonl 是**所有会话**共写的一份流水，读出来按时间一条条排。
 * 树树一天里同时开好几个对话（改插件、QQ 聊天、闲聊），排在一起就变成
 * 「我在这边说一句、那边回一句」，看不出哪句是跟谁的、哪段是同一件事。
 *
 * 分组口径：
 *   · 工作区用行里的 wd（会话的 cwd），显示成最后一段目录名；
 *   · 会话用 sid，同一天里按出现顺序编号「对话 1 / 2 / 3」；
 *   · 组内保持时间正序，组与组之间先按工作区首次出现时间、再按会话首条时间。
 * 老流水没有 wd/sid（这个字段是后加的），统一落到「未标注」一组，不丢内容。
 */

/** 从 cwd 取一个好认的名字：D:\DSH workspace\work → work */
export function workspaceLabel(wd) {
  const raw = String(wd ?? '').trim()
  if (raw === '') return '未标注工作区'
  const parts = raw.split(/[\\/]+/).filter((part) => part !== '')
  return parts.length > 0 ? parts[parts.length - 1] : raw
}

/** 组内第一条的起始时刻（毫秒）；全是坏时间戳时给 0。 */
function firstTime(rows) {
  let at = Number.POSITIVE_INFINITY
  for (const row of rows) {
    const t = Number(row?.t)
    if (Number.isFinite(t) && t < at) at = t
  }
  return Number.isFinite(at) ? at : 0
}

/**
 * 分组。返回的每组：
 *   { wd, sid, rows, index, at }
 * index 是它在所属工作区里的编号（从 1 开始，按首条时间排）。
 */
export function groupSessions(rows) {
  const source = Array.isArray(rows) ? rows : []
  const groups = new Map()

  for (const row of source) {
    if (row === null || typeof row !== 'object') continue
    const wd = String(row.wd ?? '')
    const sid = String(row.sid ?? '')
    const key = `${wd}\u0000${sid}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { wd, sid, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }

  const list = [...groups.values()]
  for (const group of list) group.at = firstTime(group.rows)

  // 工作区的次序 = 它最早那一组的时间；同一工作区内按会话首条时间排
  const wdAt = new Map()
  for (const group of list) {
    const prev = wdAt.get(group.wd)
    if (prev === undefined || group.at < prev) wdAt.set(group.wd, group.at)
  }
  list.sort((a, b) => {
    const wdDiff = (wdAt.get(a.wd) ?? 0) - (wdAt.get(b.wd) ?? 0)
    if (wdDiff !== 0) return wdDiff
    if (a.wd !== b.wd) return a.wd < b.wd ? -1 : 1
    return a.at - b.at
  })

  const counters = new Map()
  for (const group of list) {
    const n = (counters.get(group.wd) ?? 0) + 1
    counters.set(group.wd, n)
    group.index = n
  }

  return list
}

/** `21:03` —— 组头里显示这个会话是从几点开始的。 */
export function stampOf(ms) {
  const t = Number(ms)
  if (!Number.isFinite(t) || t <= 0) return '--:--'
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
