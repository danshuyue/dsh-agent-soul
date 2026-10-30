/**
 * diary.js —— 智能体日记：每天到点触发，让 agent 自己写公开 + 私密日记。
 *
 * 核心流程：
 *   ① tick() 每轮注入时，扫描新事件追加到当天 JSONL（collectForDiary）
 *   ② 定时器到点（默认 22:00）触发 runDiaryOnce：
 *      读 JSONL → LLM 摘要 → 读最近 4 天日记 → 投第一条消息（公开）→ agent 写完
 *      → 投第二条消息（私密）
 *   ③ agent 收到消息后自己用文件工具写 public/YYYY-MM-DD.md + private/YYYY-MM-DD.md
 *      两篇分两条消息投：写在同一条里的话，私密历史就摆在下面，她写公开那一步时
 *      已经看到了本不该给人看的内容。
 *   ④ 启动时 catch_up：找最近缺失日，只补那一天
 *
 * 设计参考：
 *   - 对话扫描：extract.js 的 cursor + snapshotEvents 模式（独立游标，不干扰记忆提取）
 *   - LLM 调用：mood.js 的 judgeMood 模式（流式 + 超时 + 兜底）
 *   - 定时器：dsh-onebot-channel proactive.js 的 setTimeout 自调度模式
 *   - 消息投递：dsh-onebot-channel deliver.js 的 agent.followup 模式
 *
 * ── 一天的分界线 ──
 *   不是自然日 00:00，而是 schedule 时间（默认 22:00）。
 *   日记「2026-10-29」覆盖：2026-10-28 22:00 ~ 2026-10-29 22:00。
 *   JSONL 按自然日命名，触发时读两天文件再按分界线裁剪。
 *
 * ── 触发消息的 source ──
 *   用 { kind: 'schedule' }，这样 extract.js 会跳过它（不进记忆），
 *   mood.js 也跳过（不影响心情），日记扫描自己也跳过（不进 JSONL）。
 *   agent 仍正常处理这条消息。
 */
import { appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { note, serviceOf } from './env.js'
import {
  diaryConversationsDir,
  diaryJsonlPath,
  diaryPublicPath,
  diaryPrivatePath,
  diaryPrivateDir,
  readText,
  exists,
  ensureDirs
} from './paths.js'
import { allMoodStates, loadConfig } from './store.js'
import {
  eventsSince,
  maxSeqOf,
  isHumanEvent,
  textOfContent,
  messageContentOf,
  unwrapBridgeText
} from './extract.js'
import { moodDigest, renderMoodDigest, sessionModelOf } from './mood.js'

// --------------------------------------------------------------------------
// 时间工具
// --------------------------------------------------------------------------

/** 本地日期键 YYYY-MM-DD。 */
export function todayKey(at = Date.now()) {
  const d = new Date(Number(at) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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
 * 日记日的边界：前一天 schedule 时刻 ~ 当天 schedule 时刻。
 *
 * 日记「2026-10-29」+ schedule 22:00 →
 *   start = 2026-10-28 22:00
 *   end   = 2026-10-29 22:00
 */
export function diaryDayBoundaries(dateStr, scheduleMin) {
  const dayStart = parseDateLocal(dateStr).getTime()
  if (Number.isNaN(dayStart)) return { start: 0, end: 0 }
  const sm = Number(scheduleMin) || 0
  const start = dayStart - 24 * 60 * 60 * 1000 + sm * 60 * 1000
  const end = dayStart + sm * 60 * 1000
  return { start, end }
}

// --------------------------------------------------------------------------
// 对话扫描（独立游标，不干扰 extract.js 的记忆提取游标）
// --------------------------------------------------------------------------

const diaryCursors = new Map()
const DIARY_CURSOR_MAX = 200

/** 每条 JSONL 的最大正文长度（跟 extract.js 的 MAX_CHARS 一致）。 */
const MAX_ENTRY_CHARS = 600

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
 * 扫描新事件，把 user/message + assistant/message 追加到当天 JSONL。
 *
 * 跟 extract.js 的 collectCandidates 同款游标机制，但：
 *   ① 同时收 assistant/message（日记需要看到双方对话）
 *   ② 收所有真人 user/message（不做 worthRemembering 过滤 —— 日记需要完整流水）
 *   ③ 游标独立，不干扰记忆提取
 *
 * @returns {{ scanned: number, appended: number }}
 */
export function collectForDiary(agent) {
  if (diaryCursors.size > DIARY_CURSOR_MAX) diaryCursors.clear()

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

  const events = eventsSince(agent, from)
  if (events.length === 0) return { scanned: 0, appended: 0 }

  const to = events.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0)
  // 游标记「下一个还没扫的 seq」，不是「最后一个扫过的」—— 否则会重复扫最后一条。
  diaryCursors.set(key, to + 1)

  let appended = 0
  for (const event of events) {
    const type = event?.type ?? event?.kind
    if (type !== 'user/message' && type !== 'assistant/message') continue

    // user/message：跳过宿主注入的上下文（runtime-context / schedule 等）
    // —— 复用 extract.js 的 isHumanEvent，保证和记忆提取的过滤口径一致。
    if (type === 'user/message' && !isHumanEvent(event)) continue

    const holder = event?.payload !== undefined ? event.payload : event?.data
    if (holder === undefined || holder === null) continue

    // 取正文：user 用 textOfContent（跟 extract.js 一致）；
    // assistant 用 assistantTextOf（只取 text 块，不回退思考过程）
    let text = ''
    if (type === 'user/message') {
      // 跟记忆提取同一套清洗：剥掉桥接信封（「（QQ 私聊·用户本人…）」），
      // 丢掉主动搭话/定时任务的触发模板 —— 否则日记摘要里会混进"距上次说话已经 X 小时"。
      const unwrapped = unwrapBridgeText(textOfContent(messageContentOf(event)))
      if (unwrapped.drop) continue
      text = unwrapped.text
    } else {
      text = assistantTextOf(holder)
    }
    if (text === '') continue

    const role = type === 'user/message' ? 'user' : 'assistant'
    const eventTime = Number(event?.time) || Date.now()

    appendConversation(todayKey(eventTime), {
      t: eventTime,
      role,
      text: text.slice(0, MAX_ENTRY_CHARS),
      src: String(holder?.source?.kind ?? '')
    })
    appended += 1
  }

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
    appendFileSync(diaryJsonlPath(dateKey), JSON.stringify(entry) + '\n', 'utf8')
  } catch (error) {
    note('diary', `追加对话失败：${error instanceof Error ? error.message : error}`)
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
  const { start, end } = diaryDayBoundaries(dateStr, scheduleMin)
  if (start === 0) return ''

  // 读两份 JSONL：start 所在的自然日 + dateStr 所在的自然日
  const prevKey = todayKey(start)
  const currKey = dateStr

  const entries = []
  for (const dateKey of [prevKey, currKey]) {
    for (const entry of readJsonlLines(dateKey)) {
      const t = Number(entry.t) || 0
      if (t >= start && t < end) entries.push(entry)
    }
  }

  entries.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))
  return formatConversations(entries)
}

// --------------------------------------------------------------------------
// LLM 摘要
// --------------------------------------------------------------------------

/**
 * 把当天对话全文压缩成摘要。
 *
 * 跟 mood.js 的 judgeMood 同款模式：流式调用 + 超时保护。
 * 失败返回 null，调用方用原始对话兜底（截断后直接塞进 prompt）。
 *
 * @returns {Promise<string|null>} 摘要文本；null = 失败
 */
export async function summarizeConversations(llm, text, config, agent) {
  if (!llm || typeof llm.stream !== 'function') return null
  const body = String(text ?? '').trim()
  if (body === '') return ''

  // 模型选择：优先用专门配的摘要模型，否则跟随会话模型
  const picked = (config.diarySummarizeProvider && config.diarySummarizeModel)
    ? { provider: config.diarySummarizeProvider, model: config.diarySummarizeModel }
    : sessionModelOf(agent)
  if (!picked) return null

  const sys = '你是一个对话摘要助手。把下面这段对话压缩成一段流畅的叙述，保留关键内容（聊了什么话题、重要的决定或约定、情感变化、具体事件），去掉寒暄和重复。输出纯文本，不要标题不要分段标题，300到800字。'
  const user = `下面是今天的对话记录，请压缩成一段摘要：\n\n${body}`

  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: user }],
    source: { kind: 'plugin', plugin: 'dsh-agent-soul' }
  }]

  const timeoutMs = Number(config.diarySummarizeTimeoutMs) || 30000
  let out = ''
  let timer = null

  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`摘要超时（超过 ${timeoutMs / 1000} 秒）`)), timeoutMs)
      if (timer !== null && typeof timer.unref === 'function') timer.unref()
    })

    const consume = (async () => {
      for await (const chunk of llm.stream({
        provider: picked.provider,
        model: picked.model,
        system: sys,
        messages,
        maxTokens: 1200,
        temperature: 0.3
      })) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') out += chunk.text
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') return false
      }
      return true
    })()

    consume.catch(() => {})
    const finished = await Promise.race([consume, timeout])
    if (finished === false) return null

    const summary = out.trim()
    if (summary === '') return null

    const maxChars = Number(config.diaryMaxSummaryChars) || 2000
    return summary.slice(0, maxChars)
  } catch (error) {
    note('diary', `摘要失败：${error instanceof Error ? error.message : error}`)
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// --------------------------------------------------------------------------
// 最近日记读取
// --------------------------------------------------------------------------

/**
 * 读最近 N 天的日记文件。
 *
 * 按时间正序（最旧在前）返回。
 *
 * @returns {{ public: string, all: string }}
 *   public = 仅【公开】日记，用于公开 prompt
 *   all    = 公开 + 私密，用于私密 prompt
 */
export function readRecentDiaries(dateStr, days = 4) {
  const pubEntries = []
  const allEntries = []
  const dayStart = parseDateLocal(dateStr).getTime()

  // 从最旧到最新（正序）
  for (let i = days; i >= 1; i -= 1) {
    const key = todayKey(dayStart - i * 24 * 60 * 60 * 1000)

    const pubFile = diaryPublicPath(key)
    if (exists(pubFile)) {
      const content = readText(pubFile).trim()
      if (content !== '') {
        pubEntries.push(content)
        allEntries.push(content)
      }
    }

    const privFile = diaryPrivatePath(key)
    if (exists(privFile)) {
      const content = readText(privFile).trim()
      if (content !== '') {
        allEntries.push(content)
      }
    }
  }

  return {
    public: pubEntries.join('\n\n---\n\n'),
    all: allEntries.join('\n\n---\n\n')
  }
}

// --------------------------------------------------------------------------
// 触发消息组装
// --------------------------------------------------------------------------

/**
 * 这一天对应的时间窗（毫秒）：[前一日 22:00, 当日 22:00)。
 *
 * 日记的一天以 schedule 分界（默认 22:00），不是自然日 —— 跟 readDiaryConversations
 * 的裁剪口径保持一致，心情时间线也按这个窗口筛，两边才对得上。
 */
export function diaryWindowOf(dateStr, scheduleMin) {
  const [y, m, d] = String(dateStr).split('-').map((v) => Number(v))
  const dayStart = new Date(y, (Number.isFinite(m) ? m : 1) - 1, Number.isFinite(d) ? d : 1, 0, 0, 0, 0).getTime()
  const sm = Number.isFinite(Number(scheduleMin)) ? Number(scheduleMin) : 22 * 60
  const until = dayStart + sm * 60 * 1000
  return { since: until - 24 * 60 * 60 * 1000, until }
}

/**
 * 当天的心情摘要，渲染成日记里的「情绪底色」（拿不到就返回空串）。
 *
 * 为什么公开和私密分开算：私密那篇给她全部（那本来就是心里话），
 * 公开那篇只给走向和两三句 —— 跟「先投公开、写完再投私密」是同一个隔离思路。
 */
export function buildMoodBlocks(dateStr, scheduleMin, { config = {} } = {}) {
  try {
    const states = allMoodStates()
    if (states.length === 0) return { public: '', private: '' }
    const { since, until } = diaryWindowOf(dateStr, scheduleMin)
    const digest = moodDigest(states, { since, until, maxMoments: 6 })
    if (digest.empty === true) return { public: '', private: '' }
    return {
      public: renderMoodDigest(digest, { mode: 'public', maxMoments: Number(config.diaryPublicMoodMoments) || 3 }),
      private: renderMoodDigest(digest, { mode: 'private', maxMoments: Number(config.diaryPrivateMoodMoments) || 6 })
    }
  } catch (error) {
    note('diary', `心情摘要失败：${error instanceof Error ? error.message : error}`)
    return { public: '', private: '' }
  }
}

/**
 * 组装「写公开日记」的触发消息（第一条）。
 *
 * 只喂**公开**日记历史 —— 私密历史压根不出现在这条消息里。
 *
 * 为什么不两篇写在同一条消息里：写在一条里的话，私密历史就摆在下面，
 * 她写公开那一步时已经看到了本不该给人看的内容，「公开段只喂公开日记」
 * 这句话等于没说。拆成两条、等公开那篇落盘了再投私密，才是真的隔开。
 */
export function composePublicMessage(config, dateStr, summary, recentDiaries, moodText = '') {
  const publicFile = diaryPublicPath(dateStr)
  const publicTone = String(config.diaryPublicTone ?? '').trim()
  const publicHistory = String(recentDiaries?.public ?? '').trim()

  const lines = []

  lines.push(`今天是 ${dateStr}。`)
  lines.push('')
  lines.push('今天和对方的对话内容：')
  lines.push(summary || '今天没有对话')
  // 情绪底色：只有事实与素材（心情怎么走的、当时怎么想的），不给「写得开心点」这类指令
  if (String(moodText).trim() !== '') {
    lines.push('')
    lines.push(String(moodText).trim())
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('请写今天的公开日记。这是你会拿给对方看的版本。')
  lines.push('')
  lines.push('最近几天的公开日记（按时间正序）：')
  lines.push(publicHistory || '（还没有以前的公开日记）')
  lines.push('')
  if (publicTone !== '') lines.push(`语气：${publicTone}`)
  lines.push('格式：第一行写【公开】，第二行写日期（YYYY-MM-DD），然后正文。篇幅不限，自然即可。')
  lines.push(`请写到这个文件（用绝对路径）：${publicFile}`)
  lines.push('')
  lines.push('如果今天没有对话：你可以写这段安静里想了什么、对之前日记的回想，或纯粹的意识流。')
  lines.push('')
  lines.push('写完这一篇就先停在这里，私密那篇等我下一条消息。')

  return lines.join('\n')
}

/**
 * 组装「写私密日记」的触发消息（第二条）。
 *
 * 这条才带全部历史（公开 + 私密）。投它的前提是公开那篇已经落盘。
 */
export function composePrivateMessage(config, dateStr, summary, recentDiaries, moodText = '') {
  const privateFile = diaryPrivatePath(dateStr)
  const privateTone = String(config.diaryPrivateTone ?? '').trim()
  const allHistory = String(recentDiaries?.all ?? '').trim()

  const lines = []

  lines.push(`接着写 ${dateStr} 的私密日记。`)
  lines.push('')
  lines.push('先读回你刚写的公开日记全文，然后写私密日记。这份是写给你自己的，没人会看到。')
  lines.push('')
  lines.push('今天和对方的对话内容（供参考）：')
  lines.push(summary || '今天没有对话')
  // 私密版给全部情绪记录：那些 reason 本来就是心里话，这里才该拿出来
  if (String(moodText).trim() !== '') {
    lines.push('')
    lines.push(String(moodText).trim())
  }
  lines.push('')
  lines.push('最近几天的全部日记（公开和私密都算，按时间正序）：')
  lines.push(allHistory || '（还没有以前的日记）')
  lines.push('')
  if (privateTone !== '') lines.push(`语气：${privateTone}`)
  lines.push('可以写公开版里略过的、没说出口的、对对方的真实感受。')
  lines.push('格式：第一行写【私密】，第二行写日期（YYYY-MM-DD），然后正文。篇幅不限，自然即可。')
  lines.push(`请写到这个文件（用绝对路径）：${privateFile}`)
  lines.push('')
  lines.push('如果今天没有对话：你可以写这段安静里想了什么、对之前日记的回想，或纯粹的意识流。')

  return lines.join('\n')
}

/**
 * 等一个文件被写入（mtime 变化或新建）。
 *
 * 用来判断 agent 有没有真的把公开日记写下去 —— 写完了才投私密那条。
 * 等不到也照样投（超时兜底）：不能因为这一步卡住就丢掉一整天的日记。
 *
 * @returns {Promise<boolean>} 是否在超时前等到
 */
export async function waitForWrite(file, timeoutMs, intervalMs = 2000) {
  let before = 0
  try {
    before = exists(file) ? statSync(file).mtimeMs : 0
  } catch {
    before = 0
  }
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    try {
      if (exists(file) && statSync(file).mtimeMs > before) return true
    } catch {
      /* 读不到就继续等 */
    }
  }
  return false
}

// --------------------------------------------------------------------------
// 启动补写
// --------------------------------------------------------------------------

/** 有没有写过任何一篇日记（私密目录里有 md 就算）。 */
function hasAnyDiary() {
  try {
    const dir = diaryPrivateDir()
    if (!exists(dir)) return false
    return readdirSync(dir).some((file) => String(file).endsWith('.md'))
  } catch {
    return false
  }
}

/**
 * 找「今天之前最近该补的那一天」。
 *
 * 两条门槛，缺一就不补：
 *   ① 写过至少一篇日记 —— 补写是「补断档」，不是「回溯历史」。
 *      刚装上插件时过去 7 天都没有日记，不设这道门槛会每次启动补一篇、
 *      连补 7 篇，而那些日子连对话流水都没有。
 *   ② 那天有对话 JSONL —— 没对话的日子补出来只能是意识流，
 *      价值低，还会让日记看着连续其实空洞。
 *
 * 只返回最近的一个，更早的不补（一次补十篇只会让日记变成流水账）。
 *
 * @returns {string|null} 'YYYY-MM-DD' 或 null（没有该补的日子）
 */
export function findMissingDay(todayStr, maxDays = 7) {
  const dayStart = parseDateLocal(todayStr).getTime()
  if (Number.isNaN(dayStart)) return null

  if (!hasAnyDiary()) return null

  for (let i = 1; i <= maxDays; i += 1) {
    const key = todayKey(dayStart - i * 24 * 60 * 60 * 1000)
    // 私密日记是第二步写的，有它 = 两篇都完成了
    if (exists(diaryPrivatePath(key))) continue
    if (!exists(diaryJsonlPath(key))) continue
    return key
  }
  return null
}

// --------------------------------------------------------------------------
// JSONL 清理
// --------------------------------------------------------------------------

/** 删掉超过 keepDays 天的 JSONL 文件，返回删除数。 */
export function cleanupOldJsonl(keepDays = 7) {
  try {
    const dir = diaryConversationsDir()
    if (!exists(dir)) return 0
    const files = readdirSync(dir)
    let deleted = 0
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const dateKey = file.replace(/\.jsonl$/, '')
      const dayStart = parseDateLocal(dateKey).getTime()
      if (Number.isNaN(dayStart)) continue
      if (dayStart < cutoff) {
        try {
          unlinkSync(join(dir, file))
          deleted += 1
        } catch {
          /* 删不掉就算了 */
        }
      }
    }
    if (deleted > 0) note('diary', `清理了 ${deleted} 个旧 JSONL 文件`)
    return deleted
  } catch (error) {
    note('diary', `清理 JSONL 失败：${error instanceof Error ? error.message : error}`)
    return 0
  }
}

// --------------------------------------------------------------------------
// 会话查找 + 消息投递
// --------------------------------------------------------------------------

/**
 * 找最近活跃的会话并取它的 agent。
 *
 * 不创建专用会话（DSH 插件接口没有先例），而是用 sessions.list() 找最近更新的会话，
 * 先 agents.get() 取活的，取不到就 agents.resume() 冷启动。
 * 跟 dsh-onebot-channel 的 ensureAgent 同款思路，但更简单（不需要 composeSetup）。
 *
 * @returns {Promise<object|undefined>}
 */
async function findActiveAgent(ctx) {
  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    note('diary', '没有 agents 服务')
    return undefined
  }

  let bestId = ''
  let bestStamp = ''
  try {
    const sessions = serviceOf(ctx, 'sessions')
    if (sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
      const list = sessions.list() ?? []
      for (const session of list) {
        const id = String(session?.header?.id ?? session?.id ?? '')
        if (id === '') continue
        const stamp = String(session?.header?.updatedAt ?? session?.header?.createdAt ?? '')
        if (stamp > bestStamp) {
          bestStamp = stamp
          bestId = id
        }
      }
    }
  } catch (error) {
    note('diary', `列会话失败：${error instanceof Error ? error.message : error}`)
  }

  if (bestId === '') {
    note('diary', '没有找到任何会话')
    return undefined
  }

  // 先试活的（注册表键可能是裸 id 或 'session-<id>'）
  const ids = bestId.startsWith('session-')
    ? [bestId, bestId.slice('session-'.length)]
    : [bestId, `session-${bestId}`]
  for (const id of ids) {
    try {
      const agent = agents.get(id)
      if (agent !== undefined && agent !== null) {
        note('diary', `使用活会话 ${id}`)
        return agent
      }
    } catch { /* try next */ }
  }

  // 冷启动
  if (typeof agents.resume === 'function') {
    try {
      const handle = await agents.resume({ resumeSessionId: bestId })
      const agent = handle?.agent
      if (agent !== undefined && agent !== null) {
        note('diary', `冷启动会话 ${bestId} 成功`)
        return agent
      }
    } catch (error) {
      note('diary', `冷启动失败：${error instanceof Error ? error.message : error}`)
    }
  }

  return undefined
}

/**
 * 把触发消息投进会话。
 *
 * source 用 { kind: 'schedule' }：extract.js 跳过（不进记忆）、mood.js 跳过（不判心情）、
 * diary 自己的扫描也跳过（不进 JSONL）。agent 仍正常处理这条消息。
 */
function sendDiaryTrigger(ctx, agent, text) {
  const llmService = serviceOf(ctx, 'llm')

  let makeUserMessage = (blocks) => ({
    id: randomUUID(),
    role: 'user',
    content: blocks,
    source: { kind: 'schedule', plugin: 'dsh-agent-soul' }
  })

  try {
    if (llmService !== undefined && llmService !== null && typeof llmService.createUserMessage === 'function') {
      makeUserMessage = (blocks) => {
        const msg = llmService.createUserMessage({
          content: blocks,
          source: { kind: 'schedule', plugin: 'dsh-agent-soul' }
        })
        if (msg !== null && typeof msg === 'object' && typeof msg.id === 'string' && msg.id !== '') return msg
        return { id: randomUUID(), role: 'user', content: blocks, source: { kind: 'schedule', plugin: 'dsh-agent-soul' } }
      }
    }
  } catch (error) {
    note('diary', `llm 服务取不到（${error instanceof Error ? error.message : error}），用兜底消息`)
  }

  const blocks = [{ type: 'text', text }]
  agent.followup(makeUserMessage(blocks))
}

// --------------------------------------------------------------------------
// 定时器
// --------------------------------------------------------------------------

/**
 * 启动日记定时器。返回停止函数。
 *
 * 用 setTimeout 自调度（跟 proactive.js 同款）：每次触发后重新计算下一次时间。
 * 不用 setInterval：如果触发时 DSH 刚好不在线，interval 会堆积。
 */
export function startDiaryTimer(ctx) {
  let stopped = false
  let timer = null

  const scheduleNext = () => {
    if (stopped) return
    const config = loadConfig()
    const sm = scheduleMinutes(config.diarySchedule, 22 * 60)
    const now = Date.now()

    // 今天的 schedule 时刻
    const dayStart = new Date(now)
    dayStart.setHours(0, 0, 0, 0)
    const todaySchedule = dayStart.getTime() + sm * 60 * 1000

    let nextTime = todaySchedule
    if (nextTime <= now) {
      // 今天的时间已过，排到明天
      nextTime += 24 * 60 * 60 * 1000
    }

    const delay = nextTime - now
    timer = setTimeout(() => { void runDiaryFlow() }, delay)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
    note('diary', `下次触发：${new Date(nextTime).toLocaleString()}（约 ${Math.round(delay / 1000 / 60)} 分钟后）`)
  }

  const runDiaryFlow = async () => {
    if (stopped) return
    try {
      const config = loadConfig()
      if (config.diaryEnabled === false) {
        note('diary', '日记功能已关闭，跳过本次触发')
        return
      }
      const dateStr = todayKey(Date.now())
      note('diary', `定时触发：${dateStr}`)
      await runDiaryOnce(ctx, dateStr)
      // 触发后顺手清理旧 JSONL（保留天数要 >= 补写能追溯的天数，否则补写时对话已被删）
      cleanupOldJsonl(Number(config.diaryJsonlKeepDays) || 7)
    } catch (error) {
      note('diary', `触发失败：${error instanceof Error ? error.message : error}`)
    } finally {
      scheduleNext()
    }
  }

  scheduleNext()
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

/**
 * 执行一次完整的日记生成流程。
 *
 * 1. 读当天对话 JSONL（按 schedule 分界裁剪）
 * 2. 找最近活跃会话的 agent
 * 3. LLM 摘要（失败用原始对话兜底）
 * 4. 读最近 N 天日记
 * 5. 投第一条：公开（只带公开日记历史）
 * 6. 等公开那篇落盘（超时也继续）
 * 7. 投第二条：私密（这时候才给全部历史）
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} [manualNote] 手动触发时的备注（追加到对话内容之后）
 * @returns {Promise<boolean>} 是否成功投递
 */
export async function runDiaryOnce(ctx, dateStr, manualNote) {
  const config = loadConfig()

  // overwrite=false 且日记已存在 → 跳过
  if (config.diaryOverwrite === false && exists(diaryPrivatePath(dateStr))) {
    note('diary', `${dateStr} 的日记已存在（overwrite=false），跳过`)
    return false
  }

  // 1. 读对话
  const sm = scheduleMinutes(config.diarySchedule, 22 * 60)
  let conversationText = ''
  try {
    conversationText = readDiaryConversations(dateStr, sm)
  } catch (error) {
    note('diary', `读取对话失败：${error instanceof Error ? error.message : error}`)
  }

  // 喂给摘要前先裁到上限：工具密集的一天能攒到几十万字，全量塞进去会把单次
  // 调用撑爆（或贵得离谱）。超出时保留**最近**的部分 —— 睡前回望，结尾更值得记。
  const inputMax = Number(config.diaryMaxConversationChars) || 30000
  let feedText = conversationText
  if (feedText.length > inputMax) {
    feedText = feedText.slice(-inputMax)
    note('diary', `对话 ${conversationText.length} 字，超过上限 ${inputMax}，只取最近的部分`)
  }

  // 2. 找 agent
  const agent = await findActiveAgent(ctx)
  if (agent === undefined || agent === null) {
    note('diary', '没有可用会话，日记触发失败')
    return false
  }

  // 3. 摘要
  let summary = '今天没有对话'
  if (feedText.trim() !== '') {
    const llm = serviceOf(ctx, 'llm')
    const fallbackMax = Number(config.diaryMaxSummaryChars) || 2000
    if (llm !== undefined && llm !== null) {
      const result = await summarizeConversations(llm, feedText, config, agent)
      if (result !== null && result !== '') {
        summary = result
      } else {
        // 摘要失败：原始对话截断兜底
        summary = feedText.slice(0, fallbackMax)
        note('diary', '摘要失败，用原始对话兜底（截断）')
      }
    } else {
      // 没有 LLM 服务：直接用原始对话（截断）
      summary = feedText.slice(0, fallbackMax)
    }
  }

  // 手动备注
  if (manualNote && String(manualNote).trim() !== '') {
    summary += `\n\n备注：${String(manualNote).trim()}`
  }

  // 4. 读最近日记 + 当天的情绪底色
  const recentDiaries = readRecentDiaries(dateStr, Number(config.diaryBackfillDays) || 4)
  const moodBlocks = config.moodEnabled === false
    ? { public: '', private: '' }
    : buildMoodBlocks(dateStr, sm, { config })

  // 5. 投第一条：公开（不带任何私密历史）
  try {
    sendDiaryTrigger(ctx, agent, composePublicMessage(config, dateStr, summary, recentDiaries, moodBlocks.public))
    note('diary', `公开日记触发消息已发送（${dateStr}）`)
  } catch (error) {
    note('diary', `公开日记消息发送失败：${error instanceof Error ? error.message : error}`)
    return false
  }

  // 6. 等公开那篇落盘再投第二条 —— 写在一条消息里的话，私密历史就在下面，
  //    她写公开时已经看到了，「公开只喂公开」是假的。
  const waitMs = Number(config.diaryPublicWaitMs) || 180000
  if (waitMs > 0) {
    const wrote = await waitForWrite(diaryPublicPath(dateStr), waitMs)
    note('diary', wrote
      ? '公开日记已落盘，接着投私密'
      : `等公开日记超时（${Math.round(waitMs / 1000)} 秒），仍投私密`)
  }

  // 7. 投第二条：私密（这时候才给全部历史）
  try {
    sendDiaryTrigger(ctx, agent, composePrivateMessage(config, dateStr, summary, recentDiaries, moodBlocks.private))
    note('diary', `私密日记触发消息已发送（${dateStr}）`)
    return true
  } catch (error) {
    note('diary', `私密日记消息发送失败：${error instanceof Error ? error.message : error}`)
    return false
  }
}

/**
 * 启动时补写：找最近缺失日，只补那一天。
 */
export async function runCatchUp(ctx) {
  const config = loadConfig()
  if (config.diaryCatchUp === false) return
  if (config.diaryEnabled === false) return

  const today = todayKey(Date.now())
  const missing = findMissingDay(today, 7)
  if (missing === null) {
    note('diary', '没有缺失的日记，不需要补写')
    return
  }

  note('diary', `补写缺失日：${missing}`)
  try {
    await runDiaryOnce(ctx, missing)
  } catch (error) {
    note('diary', `补写失败：${error instanceof Error ? error.message : error}`)
  }
}
