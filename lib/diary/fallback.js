/**
 * 摘录 · fallback.js —— 模型没写成时的**规则化兜底**（2026-11-21 / 0.10.0）。
 *
 * 为什么不再调模型：0.10.0 之前兜底是「自己拼一段 prompt 再调一次 llm.stream」，
 * 等于同一天为同一件事付两次钱，而且那条路出来的是一篇散文，跟「一行一条」的摘录
 * 完全不是一个形状。现在的兜底只做一件事：**把流水搬成条目**。
 *
 * 规则（照设计文档 §2.2）：
 *   · 读 `agents/diary/conversations/YYYY-MM-DD.jsonl`
 *   · 每一行取「role + 首句」，一句话一条
 *   · 最多 20 条，不调模型
 *
 * 取**最后 20 条**而不是最前 20 条：一天的流水前面多是打招呼和试探，
 * 决定和约定基本都在后面；截断方向跟 readRecentChat / 原来的兜底截断一致。
 */
import { readConversationRows } from './feed.js'

/** 兜底最多取多少条（设计文档写死的 20，不是 excerptMaxLines —— 上限由上层再裁一次）。 */
export const FALLBACK_MAX_ROWS = 20

/** 这一行的「首句」：到第一个句末标点为止，压成一行。 */
function firstSentenceOf(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  const matched = /^([\s\S]*?)[。！？!?；;]/.exec(flat)
  const sentence = (matched === null ? flat : matched[1]).trim()
  if (sentence === '') return ''
  return sentence.length > 100 ? `${sentence.slice(0, 99)}…` : sentence
}

/**
 * 从对话流水里规则化提取条目。
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {{ maxRows?: number, ownerName?: string }} [options]
 * @returns {string[]} 形如 `树树：今天把日记改成摘录了` / `她：……`
 */
export function excerptFromConversations(dateStr, { maxRows = FALLBACK_MAX_ROWS, ownerName = '' } = {}) {
  const rows = readConversationRows(dateStr, 0)
  const limit = Math.max(1, Math.trunc(Number(maxRows) || FALLBACK_MAX_ROWS))
  const picked = rows.length > limit ? rows.slice(-limit) : rows
  const who = String(ownerName ?? '').trim() === '' ? '对方' : String(ownerName).trim()
  const out = []
  for (const row of picked) {
    const sentence = firstSentenceOf(row?.text)
    if (sentence === '') continue
    out.push(`${row?.role === 'user' ? who : '她'}：${sentence}`)
  }
  return out
}
