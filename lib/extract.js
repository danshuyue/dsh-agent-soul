/**
 * extract.js —— 从会话事件里自动提炼记忆（回合后增量扫描）。
 *
 * ── 为什么需要它 ──
 * 只靠工具让 agent「主动记」是不够的：提示词说一百遍「记得记下重要的事」，
 * 她该不记还是不会记（模型对「元指令」的服从度远低于具体任务）。
 * 所以留一条自动通道：回合结束后扫一遍新事件，按规则挑出值得记的写入记忆卡。
 *
 * ── 怎么挑（全是规则，不调模型） ──
 *   ① 只看 user/message（主人说的话才是记忆素材；她自己的回复不记，否则会自我强化）
 *   ② 长度 8~600 字，跳过纯代码块 / 纯命令 / 纯符号
 *   ③ 打分过线才记（memory.scoreRecord 的 importance ≥ 阈值）
 *   ④ 单回合最多记 maxPerTick 条，按分数取前几名
 *
 * ── 增量扫描 ──
 * 按 sessionId 记「上次扫到哪个 seq」。DSH 的 session.seq 是单调的，
 * 用 firstLiveSeq 排除继承来的历史事件（冷启动/重连时的快照里含历史）。
 */
import { note } from './env.js'
import { scoreRecord } from './memory.js'

/** sessionId → 上次扫到的 seq。进程内即可：重启后从「当前 seq」重新开始，不会重复记。 */
const cursors = new Map()

/** 游标表软上限：本地单机 DSH 很少同时活跃超过这么多个会话，超过就整体清空重来。
 *  清空是安全的（下一次只初始化「从当前 seq 开始」，且 addRecord 按文本去重）。 */
const CURSOR_MAX = 200

/** 自动提取的最低重要度（低于这个只算闲聊，不值得占记忆位）。 */
const MIN_IMPORTANCE = 42
/** 太短的不记（「嗯」「好的」「1」）。 */
const MIN_CHARS = 8
/** 太长的不记（多半是粘贴的代码或日志）。 */
const MAX_CHARS = 600

/** 明显不该进记忆的内容：整段代码、命令行、纯符号、报错堆栈。 */
const NOISE_PATTERNS = [
  /^```/,
  /^\s*[\$>]\s/,
  /^(?:cd|ls|dir|git|npm|node|python|pip|curl)\s/,
  /^[\s\p{P}\p{S}]*$/u,
  /^\s*(?:at\s+\S+\s+\(|Error:|TypeError:|SyntaxError:)/,
  /^\s*[{[][\s\S]*[}\]]\s*$/
]

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min))

/**
 * 这条用户消息是不是「主人本人」说的。
 *
 * 本地 DSH 会话里 user/message 默认都是用户 → true。
 * 但经由 QQ 桥接进来的群消息会带前缀（如「（QQ群 123·群友「小明」…）」），
 * 那种不是主人，重要度和标签都不一样 —— 认错了会把群友的闲聊当成主人的偏好记一辈子。
 */
export function isOwnerMessage(text) {
  const body = String(text ?? '')
  if (/群友「/.test(body)) return false
  if (/·QQ \d+）/.test(body) && !/用户本人/.test(body)) return false
  return true
}

/** 从消息内容里取纯文本（DSH 的 content 可能是块数组）。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block?.type === 'text' ? String(block.text ?? '') : ''))
    .join('')
    .trim()
}

/** 值得记吗？返回 { ok, reason }。 */
export function worthRemembering(text, { isOwner = true } = {}) {
  const body = String(text ?? '').trim()
  if (body.length < MIN_CHARS) return { ok: false, reason: '太短' }
  if (body.length > MAX_CHARS) return { ok: false, reason: '太长（可能是粘贴的代码/日志）' }
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(body)) return { ok: false, reason: '代码/命令/符号' }
  }
  const scored = scoreRecord({ text: body, isOwner, isPrivate: true })
  if (scored.importance < MIN_IMPORTANCE) {
    return { ok: false, reason: `重要度 ${scored.importance} 低于 ${MIN_IMPORTANCE}` }
  }
  return { ok: true, scored }
}

/**
 * 取「上次扫过之后」的新事件。
 *
 * 边界处理照抄实践出来的结论：
 *   · from 不能早于 firstLiveSeq（否则会把继承的历史事件当成新事件重扫一遍）；
 *   · 上界用 seq + 1 —— DSH 的签名是 toSeqExclusive（开区间），
 *     少取一个正好可能漏掉 turn/end 或最后一条消息。
 */
export function eventsSince(agent, fromSeq) {
  try {
    const session = agent?.session
    if (session === undefined || session === null) return []
    if (typeof session.snapshotEvents === 'function') {
      const first = typeof session.firstLiveSeq === 'number' ? session.firstLiveSeq : 0
      const from = Math.max(Number(fromSeq) || 0, first)
      const to = typeof session.seq === 'number' ? session.seq + 1 : undefined
      const list = to !== undefined ? session.snapshotEvents(from, to) : session.snapshotEvents(from)
      return Array.isArray(list) ? list : []
    }
    if (Array.isArray(session.events)) {
      return session.events.filter((event) => Number(event?.seq) > Number(fromSeq))
    }
  } catch {
    /* 读不到就算了，下一回合再试 */
  }
  return []
}

/** 当前会话最大的 seq（用于初始化游标）。 */
export function maxSeqOf(agent) {
  try {
    const session = agent?.session
    if (session !== undefined && session !== null && typeof session.seq === 'number') return session.seq
  } catch {
    /* 忽略 */
  }
  const events = eventsSince(agent, -1)
  return events.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0)
}

/**
 * 扫一个会话，返回这一轮新提取到的候选记忆。
 *
 * @returns {{ candidates: {text, isOwner, scored}[], scanned: number, from: number, to: number }}
 */
export function collectCandidates(agent, { limit = 12 } = {}) {
  // 游标表防泄漏：长期进程里会话会越攒越多，先回收再继续
  if (cursors.size > CURSOR_MAX) cursors.clear()

  const sessionId = String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
  const key = sessionId !== '' ? sessionId : 'default'
  let from = cursors.get(key)
  if (from === undefined) {
    // 第一次见这个会话：把游标推到当前位置，只往后看。
    // 为什么不回扫历史：会话可能有几千条旧事件，一上来全扫一遍会把卡灌满。
    from = maxSeqOf(agent)
    cursors.set(key, from)
    return { candidates: [], scanned: 0, from, to: from }
  }

  const events = eventsSince(agent, from)
  if (events.length === 0) return { candidates: [], scanned: 0, from, to: from }

  const to = events.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0)
  cursors.set(key, to)

  const candidates = []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const text = textOfContent(event?.data?.message?.content)
    if (text === '') continue
    const isOwner = isOwnerMessage(text)
    const verdict = worthRemembering(text, { isOwner })
    if (!verdict.ok) continue
    candidates.push({ text, isOwner, scored: verdict.scored, seq: Number(event?.seq) || 0 })
  }

  // 按分数取前 N 条；同一轮里长的往往信息更多，同分时优先长的
  candidates.sort((a, b) => b.scored.importance - a.scored.importance || b.text.length - a.text.length)
  return { candidates: candidates.slice(0, clamp(limit, 1, 30)), scanned: events.length, from, to }
}

/** 清空游标（测试用 / 会话切换时）。 */
export function resetCursor(sessionId) {
  if (sessionId === undefined) cursors.clear()
  else cursors.delete(String(sessionId))
}

/** 把候选写进卡里，返回写入条数。调用方负责存盘。 */
export function ingestCandidates(card, addRecord, candidates, config, now = Date.now()) {
  let written = 0
  for (const candidate of candidates) {
    const result = addRecord(card, {
      text: candidate.text,
      isOwner: candidate.isOwner,
      isPrivate: true,
      source: 'auto'
    }, config, now)
    if (result?.ok === true) written += 1
  }
  if (written > 0) note('extract', `自动记下 ${written} 条（扫描 ${candidates.length} 个候选）`)
  return written
}
