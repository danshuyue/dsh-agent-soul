/**
 * 摘录 · history.js —— 读最近几天的摘录（2026-11-21 / 0.10.0）。
 *
 * 0.10.0 之前这个文件读的是 public/ + private/ 两篇，并返回 `{ public, all }`
 * 两套历史（公开那条只喂公开、私密那条喂全部）。现在只有一篇摘录，
 * 所以只剩一个函数：`readRecentExcerpts`。
 */
import { diaryExcerptPath, exists, readText } from '../paths.js'
import { parseDateLocal, todayKey } from './completion.js'
import { excerptLinesFromFile } from './excerpt.js'


/**
 * 读最近 N 天的摘录（按时间正序，最旧在前）。
 *
 * @param {string} dateStr 基准日（不含这一天本身）
 * @param {number} [days=3]
 * @returns {Array<{ date: string, lines: string[], text: string }>}
 */
export function readRecentExcerpts(dateStr, days = 3) {
  const out = []
  const dayStart = parseDateLocal(dateStr).getTime()
  if (!Number.isFinite(dayStart)) return out
  const count = Math.max(1, Math.trunc(Number(days) || 3))
  for (let i = count; i >= 1; i -= 1) {
    const key = todayKey(dayStart - i * 24 * 60 * 60 * 1000)
    const file = diaryExcerptPath(key)
    if (!exists(file)) continue
    const text = readText(file).trim()
    if (text === '') continue
    out.push({ date: key, lines: excerptLinesFromFile(text), text })
  }
  return out
}


/**
 * 把最近几天的摘录渲染成「每天最多 linesPerDay 条」的参考段。
 *
 * 为什么每篇要再裁一次：注入侧只拿它接一句「前几天大概是什么事」，
 * 整篇贴进去就是每轮都在烧 token（0.10.0 之前这里是 digestDiaries，
 * 每篇压成一行；现在摘录本身已经是一行一条，直接按条裁更准）。
 *
 * @param {Array<{date: string, lines: string[]}>} entries readRecentExcerpts 的结果
 * @param {{ linesPerDay?: number }} [options]
 * @returns {string} 空串 = 没有可渲染的
 */
export function renderRecentExcerpts(entries, { linesPerDay = 3 } = {}) {
  const limit = Math.max(1, Math.trunc(Number(linesPerDay) || 3))
  const blocks = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const lines = Array.isArray(entry?.lines) ? entry.lines.slice(0, limit) : []
    if (lines.length === 0) continue
    blocks.push([`${entry.date}：`, ...lines.map((line) => `- ${line}`)].join('\n'))
  }
  return blocks.join('\n')
}
