/**
 * 宿主装配 · turns.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { PERSONA_REFRESH_TURNS, STICKY_MAX_SESSIONS, STICKY_NOTE_INTERVAL_MS, name } from '../meta.js'
import { isHumanEvent } from '../../extract.js'
import { note } from '../../env.js'
import { personaInjectAtBySession, stickyRecallBySession, turnCursorBySession } from './state.js'



/**
 * 两个词集合的 Jaccard 相似度 = |A∩B| / |A∪B|。
 *
 * 选 Jaccard 而不是「命中数 / 上次词数」：后者对「这次句子特别长」不敏感 ——
 * 只要把上次的词全说一遍，再堆一堆新词进去也还是 1.0，话题其实早换了。
 * 分母用并集，新词多就自然掉下来。
 *
 * @param {Set<string>} a 上次召回用的词集合
 * @param {Set<string>} b 这次召回用的词集合
 */
export function jaccardOf(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const term of a) if (b.has(term)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}



/**
 * 取（或建）一个会话的粘性状态，顺手做 LRU 淘汰。
 *
 * 状态字段：
 *   · terms    —— 上次用于召回的词集合，下次算 Jaccard 用；
 *   · text     —— 上次注入的完整文本，命中时**原样返回**；
 *   · rendered —— 有没有「上次」可沿用。空串也是一次有效渲染，
 *                 不能拿 text === '' 当「没渲染过」，否则没召回出东西的会话
 *                 每轮都会退整卡。
 *   · lastUsedAt / lastNoteAt —— 淘汰顺序与日志限频。
 */
export function stickyStateFor(sessionId, now) {
  const existed = stickyRecallBySession.get(sessionId)
  if (existed !== undefined) {
    existed.lastUsedAt = now
    return existed
  }
  const state = { terms: new Set(), text: '', rendered: false, lastUsedAt: now, lastNoteAt: 0 }
  stickyRecallBySession.set(sessionId, state)
  if (stickyRecallBySession.size > STICKY_MAX_SESSIONS) {
    let oldestId = ''
    let oldestAt = Infinity
    for (const [id, item] of stickyRecallBySession) {
      if (id === sessionId) continue
      if (item.lastUsedAt < oldestAt) {
        oldestAt = item.lastUsedAt
        oldestId = id
      }
    }
    if (oldestId !== '') stickyRecallBySession.delete(oldestId)
  }
  return state
}



/**
 * 「因话题未变而复用上次注入」记一次日志（限频）。
 *
 * 这条是判断粘性到底有没有生效的唯一依据：日志里出现了，说明某一轮真的没重算；
 * 一直不出现，要么话题一直在跳，要么判定逻辑根本没跑到。
 */
export function noteStickyReuse(sessionId, state, now) {
  if (now - state.lastNoteAt < STICKY_NOTE_INTERVAL_MS) return
  state.lastNoteAt = now
  note('memory', `话题未变，复用上次记忆注入（会话 ${sessionId.slice(0, 8)}，${state.text.length} 字）`)
}



/**
 * 短于 4 字的 query 当退化情况处理（「嗯」「好的」「继续」这类）。
 *
 * 它们切不出有意义的词集合，Jaccard 恒为 0 —— 拿去重算只会让文本在
 * 「空串 ↔ 某条记忆」之间来回抖，等于每轮都追加一条快照。
 */
export function isDegenerateQuery(query) {
  return String(query ?? '').trim().length < 4
}



/**
 * 这个会话是不是还停在「第一轮对话」里（2026-10-30，2026-10-31 改增量）。
 *
 * 判据是「会话里出现过几条真人 user/message」：
 *   ① 同一轮内会装配多次（重试 / 标题生成），用调用计数会被提前消耗掉；
 *   ② 冷启动恢复的会话仍有历史，天然不会再注入整卡；
 *   ③ 游标按 seq 单调推进，压缩/裁剪造成的断档不会让判断倒退。
 * 读不到事件时返回 true（宁可多注入一次，也不让新会话失忆）。
 */
export function isFirstTurnOfSession(agent) {
  const session = agent?.session
  if (session === undefined || session === null) return true
  const seq = Number(session.seq)
  if (!Number.isFinite(seq)) return true
  const id = String(session.header?.id ?? '')
  if (id === '') return true

  let state = turnCursorBySession.get(id)
  if (state === undefined) {
    if (turnCursorBySession.size > 200) turnCursorBySession.clear()
    // cursor = -1：第一次见到这个会话，从最早开始扫一次，把真实条数拿到
    state = { cursor: -1, human: 0 }
    turnCursorBySession.set(id, state)
  }

  let events = []
  try {
    if (typeof session.snapshotEvents === 'function') {
      // snapshotEvents(from, to) 是半开区间，和 extract.js 的 currentUserText 同款用法
      events = session.snapshotEvents(Math.max(0, state.cursor + 1), seq + 1) || []
    } else if (Array.isArray(session.events)) {
      events = session.events.filter((event) => {
        const at = Number(event?.seq)
        return Number.isFinite(at) ? at > state.cursor : true
      })
    } else {
      return true
    }
  } catch {
    return true
  }

  if (!Array.isArray(events)) return true
  for (const event of events) {
    const kind = event?.type ?? event?.kind
    if (kind !== 'user/message') continue
    const sourceKind = event?.source?.kind ?? event?.payload?.source?.kind ?? event?.data?.source?.kind
    // 没有 source 信息的老事件也算一轮：判宽一点，别把第二轮当成第一轮
    if (sourceKind === undefined || sourceKind === 'user') state.human += 1
  }
  state.cursor = Math.max(state.cursor, seq)
  return state.human <= 1
}



// ---- 心情语气：挂在用户消息上（2026-11-01） ----

/**
 * 哪些 agent 已经打过「追加一条注入消息」的补丁。
 *
 * ⚠️ 这里必须诚实：DSH 的公开接口只能**往系统提示里加文本**，没有
 * 「改写当前这条用户消息」的钩子。所以"挂在消息上"是用 `agent/inbox/inserted`
 * 事件在**消息已经落库之后**再投一条 user 消息来实现的 —— 效果上是
 * 「树树那句话后面跟了一条心情」，但严格说它是**第二条消息**，不是改写。
 *
 * 为什么仍然这么做（而不是退回系统提示末尾）：
 *   · 系统提示一个字不动 → 长缓存不受影响
 *   · 心情是「那一刻」的状态，跟着消息走才对；放在系统提示里会一直过时
 */

/**
 * 算「这是第几轮」—— 用**最后一条 assistant 消息的 seq**当轮次标识。
 *
 * 为什么不直接用 session.seq：宿主在 preStep 的 assemble 和 step 里的 refreshContext
 * 之间会写一条 `step/start` 事件（agent-loop.js:970 `this.session.append("step/start")`），
 * seq 必变。所以 (sessionId, seq) 这个键永远命不中第二次 —— 缓存形同虚设，
 * 副作用照样每步跑两遍，every=1 和 every=2 的行为完全一样（2026-11-04 三次修）。
 *
 * 而「她最后说了一句话」才是真正的轮次边界：
 *   · 同一个 turn 内，assistant 消息没变 → 键不变 → 只算一次；
 *   · 她回了话 → 新 seq → 下一轮重新算。
 * step/start、tool/result 这些事件都不会动这个键。
 *
 * 代价是每次要扫一遍事件找最后一条 assistant/message。`lastAssistantTextOf` 早就
 * 是这么干的（而且每轮都调），所以这个成本本来就在付。
 *
 * @returns {string} 拿不到 id 时返回空串（调用方据此决定不加缓存）
 */
function turnKeyOf(agent) {
  const sid = String(agent?.session?.header?.id ?? '')
  if (sid === '') return ''
  const session = agent.session
  // 读不到事件列表时**不缓存**（返回空串），而不是拿一个常量键糊过去。
  // 原来这里 return `${sid}:-1`：那个键在整个会话生命周期里都不变，
  // 于是 memoPerStep 一辈子命中同一条 —— 副作用（语气计数、目的结算）只跑一次，
  // 之后全部静默失效。这是「出错时变得更省」的反向降级：
  // 读不到状态时应该退回「每次重算」，而不是退回「永远不重算」。
  if (typeof session?.snapshotEvents !== 'function') return ''
  let lastSeq = -1
  try {
    const events = session.snapshotEvents() ?? []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if ((event && (event.type || event.kind)) !== 'assistant/message') continue
      lastSeq = Number(event.seq) || 0
      break
    }
  } catch {
    // 抛错同样退回「不缓存」：宁可多算，也不能让整会话的副作用停摆
    return ''
  }
  return `${sid}:${lastSeq}`
}



/**
 * 同**一轮**内只算一次（2026-11-04 修 B1，第二版）。
 *
 * 宿主在一个 step 里会把每个 context 的 text() 调至少两次：
 *   · preStep 里 systemPrompt.assemble() 一次；
 *   · step 里每个 attempt 又 refreshContext() 一次（重试还要 ×N）。
 * 按「每轮一次」写的副作用因此全部翻倍 —— 语气计数器涨两次、
 * purpose.json 每步写两遍、首轮判定第二次就变成「不是首轮」。
 *
 * 缓存的是**返回值**，不只是副作用：同一个 turn 的多次装配必须拿到逐字节相同的
 * 段落，否则宿主会认为快照变了、把整段重新投递。
 *
 * @param {string} name 段名（各段各一份缓存，互不影响）
 * @param {(context: any) => string} compute
 */
export function memoPerStep(name, compute) {
  // 每个会话只留**当前这一轮**：key 里含轮次标识，如果按 key 存会一轮一条、
  // 越攒越多。这里用 sessionId 当槽位，存 { round, value }，新一轮来了就顶掉旧的。
  const cache = new Map()
  const MAX = 200
  return (context) => {
    const agent = context?.agent
    const round = turnKeyOf(agent)
    // 拿不到会话 id 时不缓存 —— 宁可多算一次，也不能让不同会话串味
    if (round === '') return compute(context)
    const slot = `${name}:${round.split(':')[0]}`
    const hit = cache.get(slot)
    if (hit !== undefined && hit.round === round) return hit.value
    const value = compute(context)
    if (cache.size > MAX) cache.clear()
    cache.set(slot, { round, value })
    return value
  }
}



/**
 * 本 turn 里有没有「真人说的话」（2026-11-04）。
 *
 * 语气是以一条 **user 消息**的身份进上下文的。如果这一轮压根没有人说话
 * （定时注入、重试、子任务回执撞上空轮），那条消息就变成「一条只有心情的空消息」——
 * 模型看到的是一个 user 说了句心情注解，可能还会顺着它回话。
 *
 * 判据不能用 `currentUserText`：它有 lookback 窗口，本轮没有新消息时会返回**上一轮**
 * 的文本，等于永远判「有」。
 *
 * 也不能只看「最后一条 user 消息是不是人话」：空轮时最后一条可能是 runtime-context
 * 或 schedule 注入，那确实该跳过；但更准确的做法是**以 turn 为界**——
 * 从后往前扫，碰到 `assistant/message` 就停（那是上一轮的结束）：
 *   · 这之间没有 human user 消息 → 本轮没人说话 → 不投
 *   · 有 → 正常投
 *
 * @returns {boolean}
 */
export function hasHumanInputThisTurn(agent) {
  try {
    const session = agent?.session
    if (typeof session?.snapshotEvents !== 'function') return false
    const events = session.snapshotEvents() ?? []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      const type = event?.type ?? event?.kind
      // 上一轮的回复 = 本 turn 的起点。走到这里还没遇到人话，就是空轮
      if (type === 'assistant/message') return false
      if (type !== 'user/message') continue
      const holder = event?.payload !== undefined ? event.payload : event?.data
      const kind = String(holder?.source?.kind ?? '')
      // 自己投的语气消息不算「有人在说话」
      if (kind === 'soul-tone') continue
      return isHumanEvent(event)
    }
  } catch {
    /* 读不到就当没人在说话：宁可这一轮不投，也别投一条空心情 */
  }
  return false
}



/**
 * 这次该不该注入人格段。
 *
 * @returns {boolean} true = 注入（并记下这次的位置）
 */
export function shouldInjectPersona(agent) {
  // 先跑一次 isFirstTurnOfSession：它会把 human 计数推进到最新
  const first = isFirstTurnOfSession(agent)
  const id = String(agent?.session?.header?.id ?? '')
  if (id === '') return true

  const human = turnCursorBySession.get(id)?.human ?? 0
  const last = personaInjectAtBySession.get(id)

  // 同一轮内会装配多次（重试 / 标题生成）。已经为这个 human 计数注入过，
  // 就不要再注入一遍 —— 否则「省消耗」反而变成一轮发好几份人格。
  if (last !== undefined && human === last) return false

  // 首轮、或从来没记过注入点（重启后 Map 是空的，补一次）、或隔得够远了
  if (first || last === undefined || human - last >= PERSONA_REFRESH_TURNS) {
    if (personaInjectAtBySession.size > 200) personaInjectAtBySession.clear()
    personaInjectAtBySession.set(id, human)
    return true
  }
  return false
}
