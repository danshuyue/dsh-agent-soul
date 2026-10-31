/**
 * diary.js —— 智能体日记：每天到点触发，让 agent 自己写公开 + 私密日记。
 *
 * 核心流程：
 *   ① tick() 每轮注入时，扫描新事件追加到当天 JSONL（collectForDiary）
 *   ② 定时器到点（默认 22:00）触发 runDiaryOnce：
 *      读 JSONL → LLM 摘要 → 读最近 4 天日记 → 投第一条消息（公开）→ agent 写完
 *      → 投第二条消息（私密）
 *   ③ 日记会话是【绑定】来的（2026-10-31）：设置页把当前会话 id 写进
 *      config.diarySessionId，投递只认这个会话。自己 agents.create 造出来的会话
 *      拿不到宿主的 setup/installSelection，没有标准工具集，agent 永远写不出文件。
 *   ④ agent 收到消息后自己用文件工具写 public/YYYY-MM-DD.md + private/YYYY-MM-DD.md
 *      两篇分两条消息投：写在同一条里的话，私密历史就摆在下面，她写公开那一步时
 *      已经看到了本不该给人看的内容。
 *   ⑤ 启动时 catch_up：找最近缺失日，只补那一天
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
  diaryDir,
  readText,
  exists,
  ensureDirs,
  // 2026-10-31：writeDiaryFile 要用它落盘。第一次跑就因为漏了这个 import
  // 报 "atomicWrite is not defined" —— 生成都成功了，死在最后一步。
  atomicWrite
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

/**
 * 昨天的日期键。
 *
 * 2026-10-31：日记改成「第二天写前一天的」。当天写只写得到半天，
 * 隔一天写，昨天的 00:00–24:00 窗口已经完整闭合。
 * 用 setDate 减一天，跨月、跨年由 Date 自己处理，不用手算。
 */
export function yesterdayKey(at = Date.now()) {
  const d = new Date(Number(at) || Date.now())
  d.setDate(d.getDate() - 1)
  return todayKey(d.getTime())
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
 * 把 finish reason 压成一行可读文本。
 *
 * 为什么需要（2026-10-31）：摘要失败以前只记一句「失败」，连模型报的错都被吞了 ——
 * 排查时看不出是路由没取到、超时还是返回格式不符。reason 的形状由宿主定义，
 * 这里不假设字段名，直接序列化（防巨大对象截断），异常的 toString 兜底。
 */
function describeFinishReason(reason) {
  if (reason === null || reason === undefined) return '没有 reason'
  try {
    const text = JSON.stringify(reason)
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return String(reason)
  }
}

/**
 * 把当天对话全文压缩成摘要。
 *
 * 跟 mood.js 的 judgeMood 同款模式：流式调用 + 超时保护。
 * 失败返回 null，调用方用原始对话兜底（截断后直接塞进 prompt）。
 *
 * 2026-10-31：每一处失败都写明原因（服务缺失 / 路由缺失 / 错误 finish / 空文本 /
 * 异常），不再只留一句「摘要失败」—— 那段日志连着出现几十次，却查不出是哪一类。
 *
 * @returns {Promise<string|null>} 摘要文本；null = 失败
 */
export async function summarizeConversations(llm, text, config, agent) {
  if (!llm || typeof llm.stream !== 'function') {
    note('diary', '摘要失败：宿主没有可用的 llm 服务（llm.stream 不可用）')
    return null
  }
  const body = String(text ?? '').trim()
  if (body === '') return ''

  // 模型选择：优先用专门配的摘要模型，否则跟随会话模型
  const configured = Boolean(config.diarySummarizeProvider && config.diarySummarizeModel)
  const picked = configured
    ? { provider: config.diarySummarizeProvider, model: config.diarySummarizeModel }
    : sessionModelOf(agent)
  if (!picked) {
    note('diary', `摘要失败：取不到模型路由（配置 provider/model=${String(config.diarySummarizeProvider ?? '') || '空'}/${String(config.diarySummarizeModel ?? '') || '空'}，sessionModelOf 也没取到 agent 的会话模型）`)
    return null
  }
  const route = `${picked.provider}/${picked.model}`

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
  let finishReason = null
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
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          finishReason = chunk.reason
          return false
        }
      }
      return true
    })()

    consume.catch(() => {})
    const finished = await Promise.race([consume, timeout])
    if (finished === false) {
      // 模型自己报错（鉴权失败、上下文超长、适配器拒绝……）：留真实 reason，
      // 别只说「失败」——这是这段时间最常出现、又最查不出原因的一类。
      note('diary', `摘要失败：模型返回错误 finish（${describeFinishReason(finishReason)}，路由 ${route}）`)
      return null
    }

    const summary = out.trim()
    if (summary === '') {
      // 流正常结束却一个字都没吐：常见于模型只回了 reasoning、或适配器把正文丢了。
      note('diary', `摘要失败：模型返回空文本（路由 ${route}，共收到 ${out.length} 字）`)
      return null
    }

    const maxChars = Number(config.diaryMaxSummaryChars) || 2000
    return summary.slice(0, maxChars)
  } catch (error) {
    note('diary', `摘要失败：调用抛异常（${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}，路由 ${route}）`)
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// --------------------------------------------------------------------------
// 直接生成日记正文（2026-10-31）
// --------------------------------------------------------------------------

/**
 * 直接调模型生成一篇日记正文，返回完整文本（含首行【公开】/【私密】与日期行）。
 *
 * 为什么要有这个（和「投消息给 agent 让她写」并存的直接版）：
 *
 *   取证证明，往绑定会话投触发消息那条路根本不进 turn —— 335 个事件里
 *   source.kind='schedule' 零命中。官方 schedule 插件同样用 agent.followup，
 *   但它在 followup 之后 `await ctx.sessions.flush(agent.session)` 拿回执；
 *   而我们这边投完就拉倒，判不出真假。
 *
 *   与其修那条链，不如绕开它：插件本来就跑在宿主进程里，llm.stream 一直能用
 *   （summarizeConversations 就是自己调的），fs 也不受文件沙箱管。
 *   所以「自己生成 → 自己 atomicWrite」= 写完就在那儿，没有中间态可失败。
 *
 * @param {object} llm   宿主 llm 服务
 * @param {object} config 插件配置
 * @param {object} agent  用于取会话模型路由（可为空）
 * @param {'public'|'private'} kind
 * @param {object} ctx    { dateStr, summary, recentDiaries, moodText }
 * @returns {Promise<string|null>} 正文；null = 失败
 */
export async function composeDiaryText(llm, config, agent, kind, ctx) {
  if (!llm || typeof llm.stream !== 'function') {
    note('diary', '日记生成失败：宿主没有可用的 llm 服务（llm.stream 不可用）')
    return null
  }

  const configured = Boolean(config.diarySummarizeProvider && config.diarySummarizeModel)
  const picked = configured
    ? { provider: config.diarySummarizeProvider, model: config.diarySummarizeModel }
    : sessionModelOf(agent)
  if (!picked) {
    note('diary', '日记生成失败：取不到模型路由（既没配 diarySummarizeProvider/Model，也没取到会话模型）')
    return null
  }
  const route = `${picked.provider}/${picked.model}`

  const isPublic = kind !== 'private'
  const tone = String(isPublic ? config.diaryPublicTone : config.diaryPrivateTone).trim()
  const history = isPublic
    ? String(ctx?.recentDiaries?.public ?? '').trim()
    : String(ctx?.recentDiaries?.all ?? '').trim()

  const lines = []
  lines.push(isPublic
    ? '你在写今天给自己的公开日记，这一篇别人会看到。'
    : '你在写今天给自己的私密日记，这一篇没人会看到。')
  lines.push('')
  lines.push(`今天是 ${ctx.dateStr}。`)
  lines.push('')
  lines.push(
    isPublic
      ? '下面是今天和你对话的完整记录（按时间顺序，带时间戳）。'
      : '下面是今天和你对话的完整记录（按时间顺序，带时间戳）。'
  )
  lines.push('')
  lines.push(String(ctx.summary ?? '').trim() || '今天没有对话')
  if (String(ctx.moodText ?? '').trim() !== '') {
    lines.push('')
    lines.push(String(ctx.moodText).trim())
  }
  lines.push('')
  lines.push(isPublic ? '最近几天的公开日记（按时间正序）：' : '最近几天的全部日记（公开和私密都算，按时间正序）：')
  lines.push(history || '（还没有以前的日记）')
  lines.push('')
  lines.push(isPublic
    ? '公开版写得平静、能拿给对方看。没写进公开版的犹豫，留给私密那篇。'
    : '私密版不是公开版的复刻。公开版说得平静的结论，这里写它背后的犹豫；公开版略过的、没说出口的，写在这儿。')
  lines.push('不要分点、不要列清单，像说话一样写下来。可长可短，别注水。')
  lines.push(`第一行只写【${isPublic ? '公开' : '私密'}】，第二行只写日期 ${ctx.dateStr}，第三行开始是正文。`)
  lines.push('只输出日记本身，不要任何解释、不要代码块标记。')

  const sys = isPublic ? '你是一个日记写作者。' : '你是一个日记写作者，写给自己的私密那篇。'
  const user = lines.join('\n') + (tone === '' ? '' : `\n\n语气：${tone}`)

  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: user }],
    source: { kind: 'plugin', plugin: 'dsh-agent-soul' }
  }]

  const timeoutMs = Number(config.diarySummarizeTimeoutMs) || 30000
  let out = ''
  let finishReason = null
  let timer = null

  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`日记生成超时（超过 ${timeoutMs / 1000} 秒）`)), timeoutMs)
      if (timer !== null && typeof timer.unref === 'function') timer.unref()
    })

    const consume = (async () => {
      for await (const chunk of llm.stream({
        provider: picked.provider,
        model: picked.model,
        system: sys,
        messages,
        maxTokens: 2000,
        temperature: 0.8
      })) {
        if (!chunk) continue
        if (chunk.type === 'text-delta') out += chunk.text
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          finishReason = chunk.reason
          return false
        }
      }
      return true
    })()

    consume.catch(() => {})
    const finished = await Promise.race([consume, timeout])
    if (finished === false) {
      note('diary', `日记生成失败：模型返回错误 finish（${describeFinishReason(finishReason)}，路由 ${route}）`)
      return null
    }

    const text = out.trim()
    if (text === '') {
      note('diary', `日记生成失败：模型返回空文本（路由 ${route}）`)
      return null
    }
    return text
  } catch (error) {
    note('diary', `日记生成失败：调用抛异常（${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}，路由 ${route}）`)
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 把一篇日记写进对应文件，返回是否成功。
 *
 * 首行/次行如果模型漏了，这里补齐 —— 格式是糖糖定的，不靠模型自觉。
 */
export function writeDiaryFile(kind, dateStr, text) {
  const target = kind === 'private' ? diaryPrivatePath(dateStr) : diaryPublicPath(dateStr)
  try {
    ensureDirs()
    const body = String(text ?? '').trim()
    const head = kind === 'private' ? '【私密】' : '【公开】'
    const normalized = body.startsWith(head)
      ? body
      : `${head}\n${dateStr}\n\n${body}`
    atomicWrite(target, normalized.endsWith('\n') ? normalized : `${normalized}\n`)
    note('diary', `${kind === 'private' ? '私密' : '公开'}日记已写入：${target}（${normalized.length} 字）`)
    return true
  } catch (error) {
    note('diary', `写日记文件失败（${target}）：${error instanceof Error ? error.message : error}`)
    return false
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
 * @returns {string} 形如 `[14:20] 树树：…` 的多行文本
 */
export function readRecentChat(dateStr, maxChars = 3000) {
  try {
    const file = diaryJsonlPath(dateStr)
    if (!exists(file)) return ''
    const lines = readText(file).split('\n').filter((line) => line.trim() !== '')
    if (lines.length === 0) return ''
    const out = []
    let used = 0
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const item = JSON.parse(lines[i])
        const text = String(item?.text ?? '').trim()
        if (text === '') continue
        const t = Number(item?.t) || 0
        const who = item?.role === 'user' ? '树树' : '我'
        const time = t > 0 ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) : ''
        const line = `${time === '' ? '' : `[${time}] `}${who}：${text}`
        if (out.length > 0 && used + line.length > maxChars) break
        out.unshift(line)
        used += line.length
      } catch {
        /* 坏行跳过 */
      }
    }
    return out.join('\n')
  } catch {
    return ''
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
 * 专属日记会话的固定 id（2026-10-30）。
 *
 * 为什么写死而不是每次 randomUUID：
 *   日记要投进**同一个**会话，她才能接着前几天的语气和约定写下去。
 *   每次新建等于每天换一个陌生人写日记，上下文接不上。
 *   这个字符串是稳定约定 —— 改名等于换会话，已有的日记会话会变成没人再投的孤儿。
 */
/**
 * 取绑定好的日记会话（2026-10-31：从「自建会话」改成「绑定已有会话」）。
 *
 * 【2026-10-31 更正】下面这段旧推理是错的，留档免得再犯：
 *
 *   ~~「create 这条路径拿不到宿主内部的 setup / installSelection，
 *   造出来的 agent 没有标准工具集」~~
 *
 * 实测：工具不在 agent 或会话里，而在宿主平面的 ctx.tools 注册表，每步由
 * systemPrompt.assemble() 现装配。绑定会话的 request/header 里 tools = 47 个，
 * write 就在其中。工具与会话来源无关，create 出来的 agent 一样有工具。
 *
 * 真正的病：投递根本没进 turn。取证显示该会话 335 个事件里
 * source.kind='schedule' 零命中 —— 消息从未到达，而不是「到了但没工具写」。
 * 换 create→get/resume 之后症状不变，正因为病不在入口。
 *
 * 现在的规则：
 *   ① 读 config.diarySessionId；空 → 记日志、跳过（不退回「最近活跃会话」）
 *   ② agents.get(id) 命中 → 直接用
 *   ③ 未命中 → agents.resume({ resumeSessionId: id }) 冷启动
 *   ④ 仍失败 → 记「绑定的日记会话不可用：<原因>」并返回 undefined
 *
 * 注意：返回 undefined 不等于「今天不用写了」——调用方必须当作失败处理。
 * 例外：diaryEnabled=false 的检查也别只放在定时器入口，补写那条路同样要走。
 *
 * @returns {Promise<object|undefined>}
 */
export async function diaryAgent(ctx) {
  const config = loadConfig()
  const sessionId = String(config.diarySessionId ?? '').trim()

  if (sessionId === '') {
    // 没有绑定就是没有绑定。以前这里会去捞「最近活跃会话」，等于把日记写进
    // 用户正在聊的那个会话 —— 语义错了，私密内容还可能摆到不该看的人面前。
    note('diary', '没有绑定日记会话（diarySessionId 为空），跳过本次投递。去设置页「日记」里点「把当前会话指定为日记会话」')
    return undefined
  }

  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    note('diary', `绑定的日记会话不可用：宿主没有 agents 服务（${sessionId}）`)
    return undefined
  }

  const reasons = []

  // ① 活着的
  try {
    const live = agents.get(sessionId)
    if (live !== undefined && live !== null) {
      note('diary', `绑定的日记会话已在运行：${sessionId}`)
      return live
    }
    reasons.push('当前不活跃')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note('diary', `取活会话 ${sessionId} 失败：${message}`)
    reasons.push(`get 失败：${message}`)
  }

  // ② 冷启动
  if (typeof agents.resume !== 'function') {
    reasons.push('agents 服务没有 resume 方法')
  } else {
    try {
      const handle = await agents.resume({ resumeSessionId: sessionId })
      const agent = handle?.agent
      if (agent !== undefined && agent !== null) {
        note('diary', `冷启动绑定的日记会话成功：${sessionId}`)
        return agent
      }
      reasons.push('resume 没有返回 agent')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      note('diary', `冷启动绑定的日记会话 ${sessionId} 失败：${message}`)
      reasons.push(`resume 失败：${message}`)
    }
  }

  note('diary', `绑定的日记会话不可用：${reasons.join('；') || '未知原因'}（${sessionId}）`)
  return undefined
}


// --------------------------------------------------------------------------
// 启动时写（2026-10-31 改造：去掉 22:00 闹钟）
// --------------------------------------------------------------------------

/**
 * 每次 DSH 启动时跑一遍日记流程。返回停止函数（保留接口形状，便于 ctx.effect 挂载）。
 *
 * 【为什么去掉定时器】
 *
 * 原先用 setTimeout 自调度，每天 22:00 叫醒写日记。可真实的机器不会 24 小时开着 ——
 * 22:00 那个点，电脑多半是关的。闹钟定得再准，人不在家，它响给谁听？
 * 而 setTimeout 本身还有个隐藏短板：DSH 不在线时它不跑，那天的日记就静默丢了。
 *
 * 现在的规则：
 *   人醒着才记得今天做过什么 —— 日记也一样。
 *   **开机第一次就写**：DSH 一起来，把该写的日子补上，然后随它去。
 *
 * 一天内多次重启不会重复写：runDiaryOnce 会先看 diaryPrivatePath(dateStr)
 * 是否已存在（config.diaryOverwrite === false 时跳过）。
 * 默认 diaryOverwrite = true，同一天重开会覆盖 —— 覆盖比丢了好。
 */
export function startDiaryTimer(ctx) {
  let stopped = false

  const runStartupFlow = async () => {
    if (stopped) return
    try {
      const config = loadConfig()
      if (config.diaryEnabled === false) {
        note('diary', '日记功能已关闭，跳过启动写')
        return
      }
      // 2026-10-31（树树定）：**写昨天，不写今天。**
      //
      // 日记本来就是回头看。当天刚聊完就写，只写得到半天；
      // 第二天再写，昨天的窗口 00:00–24:00 已经完整闭合，一天都在里面。
      // 而且这样一来「开机补」和「一直不关机」用的是同一条逻辑 —— 都是补昨天，
      // 不再需要区分机器什么时候开、什么时候关。
      const dateStr = yesterdayKey(Date.now())

      // 开机写不重复烧钱：同一天重启好几次的话，每次都重写会白花钱，
      // 还可能用「更早、内容更少」的版本盖掉后写的那篇。
      // 想强行重写：设置页手动触发（那条路径走 runDiaryOnce，那里才看 diaryOverwrite）。
      if (exists(diaryPublicPath(dateStr)) && exists(diaryPrivatePath(dateStr))) {
        note('diary', `${dateStr} 两篇都已存在，跳过`)
        cleanupOldJsonl(Number(config.diaryJsonlKeepDays) || 7)
        return
      }

      note('diary', `开始写 ${dateStr}（昨天）`)
      const ok = await runDiaryOnce(ctx, dateStr)
      // 写完再顺手看看更早的日子有没有漏的（一次只补最近的一天，避免流水账）
      if (ok) {
        try {
          const older = findMissingDay(todayKey(Date.now()), Number(config.diaryBackfillDays) || 4)
          if (older !== null && older !== dateStr) {
            note('diary', `发现更早的缺失日 ${older}，接着补`)
            await runDiaryOnce(ctx, older)
          }
        } catch (error) {
          note('diary', `往前追补失败：${error instanceof Error ? error.message : error}`)
        }
      }
      note('diary', ok ? `写完成：${dateStr}` : `写未完成：${dateStr}`)
      // 顺手清理旧 JSONL（保留天数要 >= 补写能追溯的天数，否则补写时对话已被删）
      cleanupOldJsonl(Number(config.diaryJsonlKeepDays) || 7)
    } catch (error) {
      note('diary', `写日记失败：${error instanceof Error ? error.message : error}`)
    }
  }

  // 不阻塞启动：DSH 起来的同时在后台写，写完落盘。
  // 稍等一会儿再跑 —— 让宿主服务（llm / agents）都装好，别抢跑。
  const delayMs = 5000
  const startupTimer = setTimeout(() => { void runStartupFlow() }, delayMs)
  if (startupTimer !== null && typeof startupTimer.unref === 'function') startupTimer.unref()
  note('diary', `启动写已排队（${delayMs / 1000} 秒后执行）`)

  // ── 看门狗（2026-10-31 补）─────────────────────────────────────────
  //
  // 电脑也可能一直不关机 —— 那样「开机写」一天都轮不到一次，日记照样空着。
  // 所以再加一条：活着的时候定时看一眼，发现今天还没写就补上。
  //
  // 它不是定点闹钟：不绑 22:00，只要「今天缺了」就补，所以不在乎机器几点开、几点关。
  // 检查本身只是两次文件存在性判断，几乎不花钱；真正烧钱的生成一天最多一次。
  const watchdogMs = Math.max(Number(loadConfig().diaryWatchdogMinutes || 30) * 60 * 1000, 60 * 1000)
  const watchdogTimer = setInterval(() => {
    void runStartupFlow().catch(() => {})
  }, watchdogMs)
  if (watchdogTimer !== null && typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
  note('diary', `看门狗已启动（每 ${Math.round(watchdogMs / 60000)} 分钟检查一次今天缺不缺）`)

  return () => {
    stopped = true
    if (startupTimer !== null) clearTimeout(startupTimer)
    if (watchdogTimer !== null) clearInterval(watchdogTimer)
  }
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

/**
 * 执行一次完整的日记生成流程。
 *
 * 1. 读当天对话 JSONL（按 schedule 分界裁剪）
 * 2. 取专属日记会话的 agent
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

  // 2. 取 agent
  const agent = await diaryAgent(ctx)
  if (agent === undefined || agent === null) {
    // diaryAgent 已经记过「专属会话不可用：原因」，这里只说明跳过本次投递
    note('diary', '专属日记会话不可用，跳过本次投递（下次触发再试）')
    return false
  }

  // 3. 【2026-10-31 改】不再先做摘要。
  //
  // 为什么砍掉：实测摘要只吐出 128 字（提示词要 300–800），而它挑的全是窗口
  // 开头那段技术密集讨论 —— 同一天后半段「日记投递链调查」整个被压没了，
  // 结果日记写成昨天的事。摘要由模型自己判断「什么值得记」，而这件事不该由它决定。
  // 现在直接把对话原文喂给 composeDiaryText（已按 inputMax 截过），
  // 让她同时看到一整天的全貌，自己决定写什么。
  //
  // summarizeConversations 仍保留导出（其他调用方/测试可能还在用），
  // 但日记主流程不再走它。
  let summary = feedText.trim() === '' ? '今天没有对话' : feedText
  const fallbackMax = Number(config.diaryMaxSummaryChars) || 2000
  note('diary', `喂给日记的对话原文 ${summary.length} 字（上限 ${inputMax}）`)

  // 手动备注
  if (manualNote && String(manualNote).trim() !== '') {
    summary += `\n\n备注：${String(manualNote).trim()}`
  }

  // 4. 读最近日记 + 当天的情绪底色
  const recentDiaries = readRecentDiaries(dateStr, Number(config.diaryBackfillDays) || 4)
  const moodBlocks = config.moodEnabled === false
    ? { public: '', private: '' }
    : buildMoodBlocks(dateStr, sm, { config })

  // 5–8. 直接生成并落盘（2026-10-31 改）
  //
  // 不再往会话里投消息。原因见 composeDiaryText 的注释：
  // followup 同步返回 void，「没抛异常」对 void 函数永远为真，判不出真假；
  // 而插件自己 llm.stream + atomicWrite 没有中间态 —— 写完就在那儿。
  //
  // 两篇仍然分开生成：公开那篇只喂公开历史，生成落盘之后，私密那篇才拿全部历史。
  // 「公开只喂公开」靠的是调用顺序，不靠会话隔离。
  const llm = serviceOf(ctx, 'llm')

  const publicText = await composeDiaryText(llm, config, agent, 'public', {
    dateStr, summary, recentDiaries, moodText: moodBlocks.public
  })
  if (publicText === null) {
    note('diary', `日记未完成（${dateStr}）：公开那篇生成失败，私密也不再写`)
    return false
  }
  if (!writeDiaryFile('public', dateStr, publicText)) {
    note('diary', `日记未完成（${dateStr}）：公开那篇写盘失败`)
    return false
  }

  // 公开已落盘才生成私密 —— 顺序本身就是隔离，不需要再等文件出现。
  const privateText = await composeDiaryText(llm, config, agent, 'private', {
    dateStr, summary, recentDiaries, moodText: moodBlocks.private
  })
  if (privateText === null) {
    note('diary', `日记未完成（${dateStr}）：私密那篇生成失败（公开已写入）`)
    return false
  }
  if (!writeDiaryFile('private', dateStr, privateText)) {
    note('diary', `日记未完成（${dateStr}）：私密那篇写盘失败（公开已写入）`)
    return false
  }

  note('diary', `日记完成（${dateStr}）：公开 + 私密都已落盘`)
  return true
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
