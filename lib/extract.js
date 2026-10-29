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

/**
 * 宿主自己注入的上下文来源 —— 这些 user/message **不是人在说话**，一条都不该进记忆。
 *
 * 2026-10-29 实测（解压 ~/.dsh/sessions 里两个活跃会话，共 124 条 user/message）：
 *   runtime-context 33 条、time-context 12 条、skill-catalog 3 条、
 *   user-approval 1 条、compact-checkpoint 1 条 —— 加起来比真人说的话还多。
 * 不过滤的话，记忆卡会被「当前时间是几月几号」「可用技能清单」这类垃圾塞满。
 */
const INJECTED_SOURCES = new Set([
  'runtime-context', 'time-context', 'time-sampled', 'system-reminder', 'system',
  'skill-catalog', 'user-approval', 'compact-checkpoint', 'tool-registry', 'model', 'plugin'
])

/** 人在说话的来源：真人直接说的，或桥接进来的人话（QQ 桥等）。 */
const HUMAN_SOURCES = new Set(['user', 'qq', 'qq-bridge', 'fishbuddy', 'speak-up'])

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

/**
 * 取消息正文 —— **这里 2026-10-29 修过一个致命 bug**。
 *
 * 原来写的是 `event?.data?.message?.content`，但 DSH 的真实事件是
 *
 *   {"type":"user/message","seq":16,"data":{"content":[{"type":"text","text":"…"}],
 *    "source":{"kind":"user"},"role":"user","id":"…"},"surfaceOp":"append"}
 *
 * 正文在 **`data.content`**，`data.message` 根本不存在。
 * 可选链一路吃到 undefined，`textOfContent(undefined)` 返回空串，
 * 于是每一条都 `continue` 掉 —— 表现是：扫描在跑（scanned 有数）、候选永远是 0、
 * 记忆卡一次都没被创建、日志里连句报错都没有。纯静默失效，看文件是查不出来的。
 *
 * 三条路都留着：现在（data.content）、老格式（data.message.content）、
 * 以及另一种宿主写法（payload 而不是 data，mood.js 就是这么兼容的）。
 */
export function messageContentOf(event) {
  const holder = event?.payload !== undefined ? event.payload : event?.data
  if (holder === undefined || holder === null) return undefined
  return holder.content ?? holder.message?.content
}

/** 这条 user/message 的来源标记（拿不到就是空串）。 */
export function sourceKindOf(event) {
  const holder = event?.payload !== undefined ? event.payload : event?.data
  return String(holder?.source?.kind ?? '')
}

/**
 * 这是「人在说话」吗。
 *
 * 不认识的来源一律不记 —— 记忆比心情贵得多（心情每轮覆盖，记忆会留几个月），
 * 宁可漏记一条，也不能让新出现的机器来源悄悄污染记忆卡。
 */
export function isHumanEvent(event) {
  const kind = sourceKindOf(event)
  if (kind === '') return true
  if (INJECTED_SOURCES.has(kind)) return false
  if (HUMAN_SOURCES.has(kind)) return true
  if (/^(subagent|goal|tool-|system-|schedule)/.test(kind)) return false
  return false
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
  // 游标记「下一个还没扫的 seq」，不是「最后一个扫过的」。
  // eventsSince → snapshotEvents(from, to) 是闭区间（e.seq >= from），
  // 存 to 的话下一轮 from = to 会把最后那条再扫一遍：同一条消息进两次候选，
  // recallCount 被莫名 +1，留存和「被提及次数」全都虚高。
  cursors.set(key, to + 1)

  const candidates = []
  for (const event of events) {
    // 字段名兼容 type / kind：mood.js 就是这么写的，说明两种都见过
    if ((event?.type ?? event?.kind) !== 'user/message') continue
    if (!isHumanEvent(event)) continue
    const text = textOfContent(messageContentOf(event))
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

/**
 * 这条记忆该不该**同时**进全局卡。
 *
 * 原因（2026-10-29 发现的缺口）：自动提取只按「cwd 是否为空」决定写哪张卡，
 * 而实际使用里每个对话都有工作区 → 全局卡一个字都进不去。
 * 后果是换个工作区就完全失忆，「树树是烟台大学机器人工程大二」这种跟项目无关的事，
 * 会在每个项目卡里各记一遍，彼此不知道对方存在。
 *
 * 判据：
 *   · tags 含 fact（长期事实：目标 / 专业 / 习惯 / 身份）→ 无条件合格。
 *     这类换到任何工作区都该认得你，不该受分数门槛限制。
 *   · 其余要同时满足：tags 含 self（关于你自己的偏好或情况，跟项目无关）
 *     + 重要度过线（闲聊级的不值得占全局预算）。
 * 调用方还会再查一眼：只有当前写的是项目卡时才需要双写。
 */
export function isPromotable(candidate, importance = 62) {
  const tags = Array.isArray(candidate?.scored?.tags) ? candidate.scored.tags : []
  if (tags.includes('fact')) return true
  if (!tags.includes('self')) return false
  return (Number(candidate?.scored?.importance) || 0) >= (Number(importance) || 62)
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
