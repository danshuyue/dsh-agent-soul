/**
 * echo.js —— 记忆写入回声缓冲（2026-11-04）
 *
 * 这里只做一件事：把「刚刚写进记忆的那条」暂存一小会儿，让**同一会话的下一轮**
 * 注入能把它带出来。为什么需要它：
 *   · 非首轮只注入 renderRecallOnly（top2、要求 ≥2 个词命中、≤260 字）；
 *   · 粘性召回在话题没变时（Jaccard ≥ 0.6）直接复用上次文本，根本不重算。
 *   于是刚写的记忆要等换话题或开新会话才看得见 —— 写的人（agent）既没法确认
 *   写对了，也没法顺着那条继续想。
 *
 * 为什么单独成模块、而且**只做缓冲**：
 *   这段状态是跨 step 的（工具执行时写、下一轮注入时读），不能塞进 tool.js
 *   或 index.js 的局部闭包里；同时它不该知道「怎么渲染」「写的是 global 还是
 *   project」这些业务 —— 那些是调用方的事。这里只管存、取、过期、淘汰。
 *
 * 结构：Map<sessionId, { items: [{ text, at }], at }>
 *   · items 按写入顺序排列，at 是**这一条**的写入时间（TTL 按条算）；
 *   · 外层 at 是会话最后一次被碰到的时间（LRU 淘汰用）。
 *
 * 为什么 key 必须是 session id：
 *   回声里是这个人刚写下的私事。拿不到 id 时宁可不存（见 pushEcho 的早返回），
 *   也绝不能用全局 key —— 那等于把 A 的记忆回执塞进 B 的提示词。
 */

/** 单条回声最多留 10 分钟：再久就不算「刚记下的」了，留着只会误导。 */
const ECHO_TTL_MS = 10 * 60 * 1000

/** 每个会话最多 3 条：一轮里连着写好几条时，只回显最近的三条。 */
const ECHO_MAX_ITEMS = 3

/** 每个会话回声总字符上限 600：超出丢最旧的，保证注入不被回执撑爆。 */
const ECHO_MAX_CHARS = 600

/** 会话数上限 32：跟粘性状态表同一个量级，会话开多了不能一直涨。 */
const ECHO_MAX_SESSIONS = 32

/** @type {Map<string, { items: Array<{ text: string, at: number }>, at: number }>} */
const echoesBySession = new Map()

/** id 归一化：空串 / 非字符串一律当「拿不到会话」，绝不退化成全局 key。 */
function normalizeSessionId(sessionId) {
  return typeof sessionId === 'string' ? sessionId.trim() : ''
}

/** 只留没过期的条目。返回过滤后的数组，不修改入参。 */
function freshItems(items, now) {
  if (!Array.isArray(items)) return []
  return items.filter((item) => item !== null && item !== undefined && now - Number(item.at) < ECHO_TTL_MS)
}

/** 把会话移到 Map 尾部 —— Map 保插入顺序，队首就是最久没碰过的。 */
function touchSession(sessionId, entry) {
  echoesBySession.delete(sessionId)
  echoesBySession.set(sessionId, entry)
}

/** 超过会话上限时淘汰最久未用的（正在写入的这个会话不淘汰）。 */
function evictSessions(keepId) {
  while (echoesBySession.size > ECHO_MAX_SESSIONS) {
    let oldestId = ''
    for (const id of echoesBySession.keys()) {
      if (id === keepId) continue
      oldestId = id
      break
    }
    if (oldestId === '') break
    echoesBySession.delete(oldestId)
  }
}

/**
 * 记下一条「刚写进记忆的文本」。
 *
 * 空 id / 空文本直接忽略 —— 调用方（tool.js）拿不到 sessionId 时不该留下任何痕迹。
 * 单条超过总字数上限时先截断，避免一条就把整个会话的额度吃光。
 *
 * @param {string} sessionId 会话 id；空串表示拿不到，直接返回 false
 * @param {string} text 实际写入记录里的正文
 * @returns {boolean} 有没有真的存下来
 */
export function pushEcho(sessionId, text) {
  const id = normalizeSessionId(sessionId)
  if (id === '') return false
  const body = typeof text === 'string' ? text.trim() : ''
  if (body === '') return false

  const now = Date.now()
  let entry = echoesBySession.get(id)
  if (entry === undefined) {
    entry = { items: [], at: now }
    echoesBySession.set(id, entry)
    evictSessions(id)
  } else {
    touchSession(id, entry)
  }
  entry.at = now

  // 顺手清过期：不清理的话，十分钟前写的条目会被当成「刚记下的」再回显一次。
  entry.items = freshItems(entry.items, now)

  const stored = body.length > ECHO_MAX_CHARS ? body.slice(0, ECHO_MAX_CHARS) : body
  entry.items.push({ text: stored, at: now })

  // 条数上限：超出丢最旧的。
  while (entry.items.length > ECHO_MAX_ITEMS) entry.items.shift()

  // 总字数上限：还超就继续从最旧的丢；最后一条自身已被截到上限内。
  let total = entry.items.reduce((sum, item) => sum + item.text.length, 0)
  while (total > ECHO_MAX_CHARS && entry.items.length > 1) {
    total -= entry.items.shift().text.length
  }
  return true
}

/**
 * 取出并清空一个会话的回声（一次性）。
 *
 * 为什么「取出即清空」：这是写回执，不是召回结果。下一轮确认过就够了，
 * 留着会在之后每轮重复出现，反而变成噪音。取不到 / 已过期都返回空数组。
 *
 * @param {string} sessionId
 * @returns {Array<{ text: string, at: number }>} 按写入先后排列
 */
export function takeEcho(sessionId) {
  const id = normalizeSessionId(sessionId)
  if (id === '') return []
  const entry = echoesBySession.get(id)
  if (entry === undefined) return []
  // 一次性：不管有没有过期条目，这次取过就把会话删掉。
  echoesBySession.delete(id)
  const now = Date.now()
  return freshItems(entry.items, now).map((item) => ({ text: item.text, at: item.at }))
}

/** 丢掉一个会话的回声（测试清理 / 显式撤销用）。 */
export function clearEcho(sessionId) {
  const id = normalizeSessionId(sessionId)
  if (id === '') return false
  return echoesBySession.delete(id)
}

/** 丢掉所有会话的回声（__resetForTest 用，避免用例之间串味）。 */
export function clearAllEchoes() {
  echoesBySession.clear()
}

/** 测试用：当前缓冲规模，验证会话上限淘汰真的生效。 */
export function __echoStatsForTest() {
  return { size: echoesBySession.size, max: ECHO_MAX_SESSIONS }
}

export const ECHO_LIMITS = {
  ttlMs: ECHO_TTL_MS,
  maxItems: ECHO_MAX_ITEMS,
  maxChars: ECHO_MAX_CHARS,
  maxSessions: ECHO_MAX_SESSIONS
}
