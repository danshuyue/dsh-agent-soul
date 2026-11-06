/**
 * 日记 · feed.js
 * 由 lib/diary.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { diaryDayBoundaries, todayKey } from '../diary/completion.js'
import { diaryJsonlPath, ensureDirs, exists, readText } from '../paths.js'
import { join } from 'node:path'
import { note } from '../env.js'
import { maybePruneConversations } from './files.js'
import { appendFileSync, chmodSync } from 'node:fs'
import { eventsSince, isHumanEvent, maxSeqOf, messageContentOf, textOfContent, unwrapBridgeText } from '../extract.js'


// --------------------------------------------------------------------------
// 对话扫描（独立游标，不干扰 extract.js 的记忆提取游标）
// --------------------------------------------------------------------------

const diaryCursors = new Map()

const DIARY_CURSOR_MAX = 200


/** 每条 JSONL 的最大正文长度（跟 extract.js 的 MAX_CHARS 一致）。 */
const MAX_ENTRY_CHARS = 600


/**
 * 超过这个长度、且带表格 / 代码块 / 列表的助手回复，折叠成一行提示（2026-11-05）。
 *
 * 为什么：原来是一刀切 `slice(0, 600)`。实测切出来的东西是
 * 「### 必做（3 件）……\n\n| # | 在哪 | 要做什么 |\n|---|---|---|\n| 1 | *」——
 * 一张表格的前半截，信息量几乎为零，还会让第二天读到的人以为数据坏了。
 * 表格和代码要的是「整张」，不是「前 600 字」；给不出整张，就该说清楚
 * 「这里有一大段带表格的答复」而不是留半句话。
 *
 * 200-300 字的纯文字回复不折叠：那本来就是能读懂的话。
 */
const FEED_MARKDOWN_MIN = 300


/**
 * 把一条消息压成适合进「今天流水」的样子。
 *
 * @param {string} text 原始正文
 * @param {'user'|'assistant'} role 谁说的
 * @returns {string}
 */
export function compressFeedText(text, role = 'assistant') {
  const t = String(text ?? '').trim()
  if (t === '') return ''
  if (t.length <= FEED_MARKDOWN_MIN) return t

  // 表格 / 代码块：整段折成一句话，不切半张
  const heavy = /(^|\n)\s*\|/.test(t) || t.includes('```')
  if (role === 'assistant' && heavy) {
    const head = t.replace(/[#*`|>\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    return `${head}…（这轮回了一段带表格/代码的答复，约 ${t.length} 字，已省略）`
  }

  if (t.length <= MAX_ENTRY_CHARS) return t
  // 纯文字仍然截断，但留记号：半句话至少看得出「是截的」，别让人以为原文就这么断
  return `${t.slice(0, MAX_ENTRY_CHARS)}…（省略 ${t.length - MAX_ENTRY_CHARS} 字）`
}


/**
 * 助手消息的正文：**只取 text 块**，不要思考过程。
 *
 * 为什么不能复用 mood.js 的 fullTextOf：它在没有 text 块时会回退返回 reasoning
 * 全文（`if (thinking.length) return thinking.join(' ')`）。实测一个活跃会话的
 * 286 条 assistant/message 里，只有 29 条是真正在说话，257 条（90%）是思考过程；
 * 经 fullTextOf 后 49.5 万字里有 46.2 万字（93%）来自思考过程。
 * 后果是日记的「对话流水」几乎全是她的内心独白（还多是英文盘算），
 * 摘要基于独白而非对话，而且体积会撑爆单次 LLM 调用。
 *
 * 日记要记的是她说出口的话。思考过程是过程，不是内容。
 */
function assistantTextOf(holder) {
  // 助手消息的正文在 data.message.content（有 message 这一层），跟 user 的 data.content 不同
  const content = holder?.message?.content ?? holder?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    // 只认 type === 'text'：reasoning（思考）和 tool-call（工具调用）都不进日记
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').trim()
}


/**
 * 写盘失败的退避状态（2026-11-04 修新③）。
 *
 * 「写不进就停住游标、下一轮重试」这个方向是对的 —— 但它没有退路：
 * 万一那天的 JSONL 路径本身就是个坏目标（同名目录、磁盘满、权限没了），
 * 游标就永远停在那儿，每次装��都重试一次、每次都失败，
 * **这个会话从那一刻起再也不记录任何对话**。
 *
 * 所以给它一个上限：同一个位置连续失败 3 次、或者拖了半小时还没好，
 * 就认命跳过这一条（记一条显眼的日志），让会话能继续往前走 ——
 * 丢一条消息，好过整个会话从此静音。
 */
const seekFailures = new Map()

const SEEK_MAX_RETRY = 3

const SEEK_GIVE_UP_MS = 30 * 60 * 1000


export function collectForDiary(agent) {
  if (diaryCursors.size > DIARY_CURSOR_MAX) diaryCursors.clear()

  // 2026-11-04 修 B7：清理挂在日记流程里（runDiaryOnce / 看门狗）是不够的 ——
  // diaryEnabled=false 时 startDiaryTimer 根本不启动，collectForDiary 却照旧每轮追加，
  // 关掉日记之后 conversations/*.jsonl 只涨不消。清理跟「要不要写日记」无关，
  // 该在这里做。2026-11-05 接上 retention.js 的可配置保留期（默认不删）。
  maybePruneConversations()

  const sessionId = String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
  const key = sessionId !== '' ? sessionId : 'default'

  let from = diaryCursors.get(key)
  if (from === undefined) {
    // 第一次见这个会话：把游标推到当前位置的下一个，只往后看。
    // 不用 maxSeqOf(agent) 本身：eventsSince 用 seq >= from（闭区间），
    // 存 maxSeq 会在下一轮把最后那条再扫一遍。+1 才是「下一个还没扫的」。
    // 不回扫历史 —— 会话可能有几千条旧事件，一上来全扫会把 JSONL 灌满。
    from = maxSeqOf(agent) + 1
    diaryCursors.set(key, from)
    return { scanned: 0, appended: 0 }
  }

  // 退避：同一个位置连续失败太多次，就放弃它（见 seekFailures 的注释）
  const stuck = seekFailures.get(key)
  if (stuck !== undefined) {
    // 时间这条要用 firstAt（第一次失败的时刻）。
    // 用 lastAt 的话，每次重试都把时间往后推，这条退路永远不触发 —— 等于没有
    // （2026-11-04 修：原来写的是 lastAt，实际只有计数那条在起作用）。
    const giveUp = stuck.count >= SEEK_MAX_RETRY || (Date.now() - stuck.firstAt) > SEEK_GIVE_UP_MS
    if (giveUp) {
      note('diary', `${key} 的 seq=${stuck.seq} 连续 ${stuck.count} 次写不进，放弃这一条并推进游标 —— 再不跳会话就永远不记录了`)
      from = stuck.seq + 1
      diaryCursors.set(key, from)
      seekFailures.delete(key)
    }
  }

  const events = eventsSince(agent, from)
  if (events.length === 0) return { scanned: 0, appended: 0 }

  // 2026-11-04 修 B3：**游标最后才推进，而且只推进到「真正落盘成功的那条」**。
  //
  // 原来是先 `cursors.set(key, to + 1)` 再逐条 append，而 appendConversation
  // 内部把写盘异常吞成一行日志。于是 ENOSPC、文件被占、卡只读的那一次，
  // 这批对话既不进 JSONL 也不进记忆，下一轮从 to+1 开始扫 —— **永久丢失**。
  //
  // 现在：成功一条推一条；失败就地停住，下一轮从失败那条重扫。
  let lastDone = from - 1
  let appended = 0

  for (const event of events) {
    const seq = Number(event?.seq) || 0
    const type = event?.type ?? event?.kind
    if (type !== 'user/message' && type !== 'assistant/message') {
      lastDone = seq
      continue
    }

    // user/message：跳过宿主注入的上下文（runtime-context / schedule 等）
    // —— 复用 extract.js 的 isHumanEvent，保证和记忆提取的过滤口径一致。
    if (type === 'user/message' && !isHumanEvent(event)) {
      lastDone = seq
      continue
    }

    const holder = event?.payload !== undefined ? event.payload : event?.data
    if (holder === undefined || holder === null) {
      lastDone = seq
      continue
    }

    // 取正文：user 用 textOfContent（跟 extract.js 一致）；
    // assistant 用 assistantTextOf（只取 text 块，不回退思考过程）
    let text = ''
    if (type === 'user/message') {
      // 跟记忆提取同一套清洗：剥掉桥接信封（「（QQ 私聊·用户本人…）」），
      // 丢掉主动搭话/定时任务的触发模板 —— 否则日记摘要里会混进"距上次说话已经 X 小时"。
      const unwrapped = unwrapBridgeText(textOfContent(messageContentOf(event)))
      if (unwrapped.drop) {
        lastDone = seq
        continue
      }
      text = unwrapped.text
    } else {
      text = assistantTextOf(holder)
    }
    if (text === '') {
      lastDone = seq
      continue
    }

    const role = type === 'user/message' ? 'user' : 'assistant'
    const eventTime = Number(event?.time) || Date.now()

    const written = appendConversation(todayKey(eventTime), {
      t: eventTime,
      role,
      text: compressFeedText(text, role),
      src: String(holder?.source?.kind ?? '')
    })
    if (written !== true) {
      // 写不进去就停在这里：游标停在失败那条之前，下一轮重扫它。
      // 但要记账，否则坏目标会让这个会话永久静音（见 seekFailures）。
      const prev = seekFailures.get(key)
      const sameSpot = prev !== undefined && prev.seq === seq
      seekFailures.set(key, {
        seq,
        count: (sameSpot ? prev.count : 0) + 1,
        firstAt: sameSpot && Number.isFinite(prev.firstAt) ? prev.firstAt : Date.now(),
        lastAt: Date.now()
      })
      note('diary', `对话落盘失败，游标停在 seq=${seq}（第 ${seekFailures.get(key).count} 次），下一轮重试`)
      break
    }
    lastDone = seq
    appended += 1
    // 有进展就清掉失败计数：说明磁盘/权限已经恢复了
    if (seekFailures.has(key)) seekFailures.delete(key)
  }

  diaryCursors.set(key, lastDone + 1)
  return { scanned: events.length, appended }
}


/** 测试用：清空游标。 */
export function resetDiaryCursor(sessionId) {
  if (sessionId === undefined) diaryCursors.clear()
  else diaryCursors.delete(String(sessionId))
}


// --------------------------------------------------------------------------
// JSONL 读写
// --------------------------------------------------------------------------

/** 目录只在第一次写入时建一次：appendConversation 每轮都跑，不该每次都 mkdir。 */
let dirsReady = false


/** 追加一行到当天 JSONL。 */
function appendConversation(dateKey, entry) {
  try {
    if (!dirsReady) {
      ensureDirs()
      dirsReady = true
    }
    // 2026-11-05 S2 / P1-5：conversations/*.jsonl 存的是对话原话，
    // Linux/macOS 上默认 0644；写时带 0o600，已有文件再补一次 chmod。
    const file = diaryJsonlPath(dateKey)
    appendFileSync(file, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* Windows 忽略 */ }
    return true
  } catch (error) {
    // 2026-11-04：返回值现在被游标用来决定「能不能往前推」。
    // 以前吞掉异常当成成功，写盘失败那批内容就永久从日记里消失了（见 collectForDiary 注释）。
    note('diary', `追加对话失败：${error instanceof Error ? error.message : error}`)
    return false
  }
}


/** 读一个自然日的全部 JSONL 行。文件不存在返回空数组。 */
function readJsonlLines(dateKey) {
  const file = diaryJsonlPath(dateKey)
  if (!exists(file)) return []
  const text = readText(file)
  if (text === '') return []
  const lines = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      lines.push(JSON.parse(trimmed))
    } catch {
      /* 坏行跳过，不丢整份 */
    }
  }
  return lines
}


/** 把 JSONL 行格式化成人看的对话文本。 */
function formatConversations(entries) {
  if (entries.length === 0) return ''
  const lines = []
  for (const entry of entries) {
    const time = new Date(Number(entry.t) || Date.now())
    const pad = (n) => String(n).padStart(2, '0')
    const hhmm = `${pad(time.getHours())}:${pad(time.getMinutes())}`
    const who = entry.role === 'user' ? '对方' : '我'
    lines.push(`[${hhmm}] ${who}：${String(entry.text ?? '')}`)
  }
  return lines.join('\n')
}


/**
 * 读一个日记日的对话（按 schedule 分界线裁剪）。
 *
 * 日记日 = 前一天 schedule ~ 当天 schedule。
 * JSONL 按自然日命名，所以要读两份文件，再按时间戳裁剪。
 *
 * @returns {string} 格式化后的对话文本；没有对话返回空串
 */
export function readDiaryConversations(dateStr, scheduleMin) {
  return formatConversations(readConversationRows(dateStr, scheduleMin))
}


/**
 * 读一个日记日的对话，**返回结构化行**（2026-11-02 加）。
 *
 * 挑对话（diary-pick.js）要按条打分，所以不能只有拼好的文本。
 * 走得和 readDiaryConversations 同一条路径、同一个窗口，两边不会对不上。
 *
 * @returns {Array<{role: string, text: string, t: number}>} 已按时间正序
 */
export function readConversationRows(dateStr, scheduleMin) {
  const { start, end } = diaryDayBoundaries(dateStr, scheduleMin)
  if (start === 0) return []

  const prevKey = todayKey(start)
  const currKey = dateStr

  const entries = []
  // ⚠️ 自然日边界下 start 就是当天 00:00，prevKey === currKey —— 不判重的话
  // 同一个 JSONL 会被读两遍，每条对话重复出现在日记里（2026-11-02 实测踩到）。
  // 改成「按 key 去重」，两种边界口径都安全。
  for (const dateKey of new Set([prevKey, currKey])) {
    for (const entry of readJsonlLines(dateKey)) {
      const t = Number(entry.t) || 0
      if (t >= start && t < end) entries.push(entry)
    }
  }

  entries.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))
  return entries
}


/**
 * 今天到目前为止的对话流水（2026-10-31 新增）。
 *
 * 为什么需要它：树树不会在一个对话里做完所有事 —— 修插件、QQ 聊天、
 * 闲聊是分开的会话。可记忆卡只有零碎事实，日记又只写到"昨天"。
 * 于是新开一个对话时，她不知道"今天早些时候在别的对话里做过什么"。
 *
 * `conversations/YYYY-MM-DD.jsonl` 是**所有会话**共同追加的流水
 * （collectForDiary 每个会话各写各的），所以从这里能读到今天全貌。
 *
 * 从尾部往前取，够 maxChars 就停 —— 最近的更相关。
 * 单条超长也至少保留一条，否则这里会返回空、等于没注入。
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {number} maxChars 大约取多少字
 * @param {string} ownerName 对话里主人怎么标（空 = 中性的「对方」，2026-11-04）
 * @returns {string} 形如 `[14:20] 树树：…` 的多行文本
 */
export function readRecentChat(dateStr, maxChars = 3000, ownerName = '') {
  const who = String(ownerName ?? '').trim() === '' ? '对方' : String(ownerName).trim()
  try {
    const file = diaryJsonlPath(dateStr)
    if (!exists(file)) return ''
    const lines = readText(file).split('\n').filter((line) => line.trim() !== '')
    if (lines.length === 0) return ''
    // 2026-11-05：按事件时间排，不按行序。
    // JSONL 是多个会话各自异步追加的（collectForDiary 每个会话写自己的那几条），
    // 落盘顺序 ≠ 发生顺序。原来直接倒着读行，注入里就出现「19:05 排在 19:33 后面」——
    // 因果关系读起来是反的，比省下的两行代码贵得多。
    const items = []
    for (const raw of lines) {
      try {
        const item = JSON.parse(raw)
        const text = String(item?.text ?? '').trim()
        if (text === '') continue
        items.push({ t: Number(item?.t) || 0, role: item?.role === 'user' ? 'user' : 'assistant', text })
      } catch {
        /* 坏行跳过 */
      }
    }
    // 同一毫秒的保持原文件顺序（Array#sort 是稳定的）
    items.sort((a, b) => a.t - b.t)

    const out = []
    let used = 0
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]
      const label = item.role === 'user' ? who : '我'
      const time = item.t > 0 ? new Date(item.t).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) : ''
      const line = `${time === '' ? '' : `[${time}] `}${label}：${item.text}`
      if (out.length > 0 && used + line.length > maxChars) break
      out.unshift(line)
      used += line.length
    }
    return out.join('\n')
  } catch {
    return ''
  }
}
