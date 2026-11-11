/**
 * 宿主装配 · segment-cache.js —— 四段系统提示的渲染缓存（2026-11-11）
 *
 * ── 为什么缓存「渲染结果」而不是「发送」──
 *   系统提示是**每轮整份重发**的（API 无状态），所以省不了发送；能省的只有
 *   「读盘 + 拼字符串」。更值钱的是 **prefix cache**：系统提示内容越稳定，
 *   DeepSeek 的命中前缀越长、越便宜。内容一变就整段失效、按全价算。
 *
 *   所以这里的目标有两个，缺一不可：
 *     ① 少重算（读盘 / 拼串）；
 *     ② 输出**逐字节稳定** —— 同一个会话、同一份数据，非刷新轮次必须拿到
 *        和上次一模一样的文本，而不是空串或重新拼出来的近似文本。
 *
 * ── 为什么「永远不会返回空串」是硬约束 ──
 *   人格段曾经这样：`shouldInjectPersona` 在非刷新轮次返回 false，调用方直接
 *   `return ''`，于是 15 轮里 14 轮系统提示里没有身份；更糟的是系统提示在
 *   「一空一有」之间反复跳，prefix cache 每轮全废。缓存未命中就 compute、
 *   命中就交回上次的原文 —— 任何一条路径都不允许凭空返回 ''。
 *   （compute 自己返回 '' 属于内容问题：真没有记忆/笔记时就是空的，照实返回。）
 *
 * ── key 与隔离 ──
 *   缓存按 `(key, sessionId)` 存：`{ sig, turn, text }`。
 *   · key 形如 'persona' / 'memory' / 'notes' / 'purpose'，四段各一份；
 *   · 拿不到 sessionId 时**不缓存**，直接 compute —— 宁可多算，
 *     也不能把 A 会话的记忆文本塞进 B 会话的提示词。
 *
 * ── 什么时候重算 ──
 *   · sig 变了（文件的 mtime+size / 用户这句话 / 时段等「廉价指纹」）；
 *   · 距离上次渲染过了 `everyTurns` 个人话轮次（兜底：sig 漏掉的变化也会定期刷新）；
 *   · 被 invalidateSegment / invalidateAll 主动作废（写盘之后调用）。
 *   轮次用 turns.js 的 `isFirstTurnOfSession` 推进的 human 计数 —— 它天然
 *   「同一轮内多次装配不涨」，正好对应宿主 preStep + refreshContext 的多次调用。
 */
import { statSync } from 'node:fs'
import { trimMap } from '../../core/lru.js'
import { STICKY_MAX_SESSIONS } from '../meta.js'
import { isFirstTurnOfSession } from './turns.js'
import { turnCursorBySession } from './state.js'

/**
 * 缓存槽上限（按 `(key, sessionId)` 计）。
 *
 * 四段 × 32 个会话 = 128 槽，跟 STICKY_MAX_SESSIONS 同一个量级：
 * 会话开多了按插入顺序淘汰最旧的，不整体清空（`map.clear()` 会让所有会话
 * 同时失忆，见 core/lru.js 的头注释）。
 */
export const SEGMENT_CACHE_MAX_ENTRIES = STICKY_MAX_SESSIONS * 4

/** key 与 sessionId 的分隔符：用 NUL，正常 id 里不可能出现。 */
const SEP = '\u0000'

/** @type {Map<string, { sig: string, turn: number, text: string }>} */
const entries = new Map()

/** sessionId 归一化：拿不到就是空串，绝不退化成全局 key。 */
function sessionIdOf(agent) {
  const raw = agent?.session?.header?.id
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 把 compute 的返回值收敛成字符串；undefined/null 视为空串。 */
function asText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 取该会话该段的渲染结果；命中缓存就直接返回，不再读盘。
 *
 * @param {any} agent 宿主上下文里的 agent（用来取 session id 与轮次）
 * @param {string} key 段名：'persona' / 'memory' / 'notes' / 'purpose'
 * @param {() => string} compute 未命中时真正渲染的函数
 * @param {{ sig?: string, everyTurns?: number }} [options]
 *   sig: 内容的廉价指纹（文件 mtime+size 拼串、query 指纹……）。变了就重算。
 *   everyTurns: 最多沿用一个渲染结果多少个人话轮次，默认 7。
 * @returns {string}
 */
export function renderCached(agent, key, compute, { sig = '', everyTurns = 7 } = {}) {
  const name = String(key ?? '')
  const computeText = typeof compute === 'function' ? compute : () => ''
  const sessionId = sessionIdOf(agent)

  // 拿不到会话（或没给 key）→ 不缓存，直接算。宁可多算，不能串会话。
  if (sessionId === '' || name === '') return asText(computeText())

  // 先推进 human 计数：它只在「真的多了一轮人话」时才涨，
  // 同一轮里宿主装配几次都不涨 —— 这正是我们要的轮次边界。
  isFirstTurnOfSession(agent)
  const human = Number(turnCursorBySession.get(sessionId)?.human ?? 0)
  const every = Math.max(1, Math.trunc(Number(everyTurns) || 1))
  const slot = `${name}${SEP}${sessionId}`

  const hit = entries.get(slot)
  if (hit !== undefined && hit.sig === sig && human - hit.turn < every) {
    // 命中：挪到队尾，淘汰时它就不是最旧的
    entries.delete(slot)
    entries.set(slot, hit)
    return hit.text
  }

  const text = asText(computeText())
  entries.delete(slot)
  entries.set(slot, { sig, turn: human, text })
  trimMap(entries, SEGMENT_CACHE_MAX_ENTRIES)
  return text
}

/**
 * 主动作废某一段（写记忆 / 笔记 / 目的之后调用，下一轮立刻能看见）。
 * @param {string} key
 * @returns {number} 作废了几个槽
 */
export function invalidateSegment(key) {
  const name = String(key ?? '')
  if (name === '') return 0
  const prefix = `${name}${SEP}`
  let dropped = 0
  for (const slot of entries.keys()) {
    if (slot.startsWith(prefix)) {
      entries.delete(slot)
      dropped += 1
    }
  }
  return dropped
}

/** 作废所有会话的所有段（测试 / 配置整份重载时用）。 */
export function invalidateAll() {
  entries.clear()
}

/** 测试用：清空缓存。 */
export function __resetSegmentCacheForTest() {
  entries.clear()
}

/** 测试用：当前缓存规模（验证上限淘汰真的生效）。 */
export function __segmentCacheStatsForTest() {
  return { size: entries.size, max: SEGMENT_CACHE_MAX_ENTRIES }
}

/**
 * 多个文件 / 目录的「mtime + size」指纹。
 *
 * 不存在或读不到时记 `0:0`，不抛：注入路径上任何一次 stat 失败都不该
 * 把整段系统提示弄没（宁可让 sig 看起来「没变」、交给 everyTurns 兜底）。
 * 目录也能传：目录的 mtime 会随条目增删变化，正好用来兜「手动放进来的笔记」。
 *
 * @param {...(string|null|undefined)} files
 * @returns {string}
 */
export function fileSignature(...files) {
  const list = files.flat(Infinity)
  const parts = []
  for (const raw of list) {
    if (typeof raw !== 'string' || raw === '') continue
    try {
      const stat = statSync(raw)
      parts.push(`${raw}:${stat.mtimeMs}:${stat.size}`)
    } catch {
      parts.push(`${raw}:0:0`)
    }
  }
  return parts.join('|')
}
