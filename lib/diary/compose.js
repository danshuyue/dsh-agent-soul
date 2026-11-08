/**
 * 日记 · compose.js
 * 由 lib/diary.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { DATA_BOUNDARY_POLICY, wrapUntrusted } from '../core/prompt-guard.js'
import { allMoodStates } from '../store.js'
import { consumeLlmStream } from '../core/llm-stream.js'
import { diaryPrivatePath, diaryPublicPath, exists, readText } from '../paths.js'
import { join } from 'node:path'
import { moodDigest, renderMoodDigest } from '../mood.js'
import { note, serviceOf } from '../env.js'
import { parseDateLocal, todayKey } from '../diary/completion.js'
import { randomUUID } from 'node:crypto'
import { readSessionMeta } from '../session-title.js'
import { sessionModelOf } from '../mood/session.js'


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
    + `\n\n${DATA_BOUNDARY_POLICY}`
  // 2026-11-05 S2 / P1-4：body 是整段对话原话，包进数据边界。
  const user = `下面是今天的对话记录，请压缩成一段摘要：\n\n${wrapUntrusted('今天的对话', body)}`

  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: user }],
    source: { kind: 'plugin', plugin: 'dsh-agent-soul' }
  }]

  // 2026-11-05 修 P2-11：竞速点下沉到 iterator.next()，超时主动关迭代器。
  const timeoutMs = Number(config.diarySummarizeTimeoutMs) || 30000
  const streamed = await consumeLlmStream(llm, {
    provider: picked.provider,
    model: picked.model,
    system: sys,
    messages,
    maxTokens: 1200,
    temperature: 0.3
  }, { timeoutMs })
  if (!streamed.ok) {
    if (streamed.finishReason !== null) {
      // 模型自己报错（鉴权失败、上下文超长、适配器拒绝……）：留真实 reason，
      // 别只说「失败」——这是这段时间最常出现、又最查不出原因的一类。
      note('diary', `摘要失败：模型返回错误 finish（${describeFinishReason(streamed.finishReason)}，路由 ${route}）`)
    } else {
      note('diary', `摘要失败：调用抛异常（${streamed.error}，路由 ${route}）`)
    }
    return null
  }

  const out = streamed.text
  const summary = out.trim()
  if (summary === '') {
    // 流正常结束却一个字都没吐：常见于模型只回了 reasoning、或适配器把正文丢了。
    note('diary', `摘要失败：模型返回空文本（路由 ${route}，共收到 ${out.length} 字）`)
    return null
  }

  // 「已停用，仅为兼容旧配置保留」：这里只属于废弃的摘要路径，
  // 日记主流程已不做摘要（2026-11-06 审计 Q2：原文写「见 1586 行」，
  // 那是拆分前的 diary.js 行号，这个文件现在只有 589 行，引用已失效）。
  // 改这个值不影响正文，只影响 LLM 兜底那一段的截断长度。
  const maxChars = Number(config.diaryMaxSummaryChars) || 2000
  return summary.slice(0, maxChars)
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
 * @param {object} ctx    { dateStr, summary, recentDiaries, moodText, threadSection }
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
  lines.push(wrapUntrusted('今天的对话', String(ctx.summary ?? '').trim() || '今天没有对话'))
  if (String(ctx.moodText ?? '').trim() !== '') {
    lines.push('')
    lines.push(wrapUntrusted('情绪记录', String(ctx.moodText).trim()))
  }
  // 连续线：还悬着的事。措辞里已经写明"这是惦记不是任务清单"——
  // 不这么写，日记会立刻变成每日进度汇报。
  if (String(ctx.threadSection ?? '').trim() !== '') {
    lines.push('')
    lines.push(wrapUntrusted('连续线', String(ctx.threadSection).trim()))
  }
  lines.push('')
  lines.push(isPublic ? '最近几天的公开日记（按时间正序）：' : '最近几天的全部日记（公开和私密都算，按时间正序）：')
  lines.push(wrapUntrusted('历史日记', history || '（还没有以前的日记）'))
  lines.push('')
  lines.push(isPublic
    ? '公开版写得平静、能拿给对方看。没写进公开版的犹豫，留给私密那篇。'
    : '私密版不是公开版的复刻。公开版说得平静的结论，这里写它背后的犹豫；公开版略过的、没说出口的，写在这儿。')
  // 主题线索（2026-11-03 加）。
  //
  // 起因：把 30000 字的技术噪音换成 8000 字的精选之后，日记变全了，但变散了 ——
  // 变成「早上…中午…下午…晚上…」的时间线铺陈，每件事都写到，没有一件写透。
  // 而语料残缺的旧版反而更好读：因为它只能抓住一个主题写深。
  //
  // 所以要明说：先找那一件，围绕它写。其余的事提到就行，不用按时间铺。
  lines.push('动笔之前先想一件事：今天最让你放不下的那一件是什么。')
  lines.push('整篇围绕它写透 —— 它让你想到什么、你当时什么反应、后来怎么想通的。')
  lines.push('其他事提到了就够，不用按时间一件件铺。流水账没有意义。')
  lines.push('')
  lines.push('不要分点、不要列清单，像说话一样写下来。可长可短，别注水。')
  lines.push(`第一行只写【${isPublic ? '公开' : '私密'}】，第二行只写日期 ${ctx.dateStr}，第三行开始是正文。`)
  lines.push('只输出日记本身，不要任何解释、不要代码块标记。')

  const sys = (isPublic ? '你是一个日记写作者。' : '你是一个日记写作者，写给自己的私密那篇。')
    + `\n\n${DATA_BOUNDARY_POLICY}`
  const user = lines.join('\n') + (tone === '' ? '' : `\n\n语气：${tone}`)

  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: user }],
    source: { kind: 'plugin', plugin: 'dsh-agent-soul' }
  }]

  // 2026-11-05 修 P2-11：与 summarizeConversations 同款，统一走 llm-stream.js。
  const timeoutMs = Number(config.diarySummarizeTimeoutMs) || 30000
  const streamed = await consumeLlmStream(llm, {
    provider: picked.provider,
    model: picked.model,
    system: sys,
    messages,
    maxTokens: 2000,
    temperature: 0.8
  }, { timeoutMs })
  if (!streamed.ok) {
    if (streamed.finishReason !== null) {
      note('diary', `日记生成失败：模型返回错误 finish（${describeFinishReason(streamed.finishReason)}，路由 ${route}）`)
    } else {
      note('diary', `日记生成失败：调用抛异常（${streamed.error}，路由 ${route}）`)
    }
    return null
  }

  const text = streamed.text.trim()
  if (text === '') {
    note('diary', `日记生成失败：模型返回空文本（路由 ${route}）`)
    return null
  }
  return text
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
 * 把几篇日记压成「每篇一行」的摘要（2026-11-05）。
 *
 * 为什么：新对话首轮会把最近两天的日记**整篇**注入，实测约 3000 字，
 * 是开场里最大的一块；而日记的价值在「昨天大概是什么事」，不在逐段复述。
 * 这里取每篇的第一段（日记的第一段本来就是当天的主题句），保留日期和全文字数，
 * 想细看再按日期去读文件。
 *
 * @param {string} text readRecentDiaries 的返回值（多篇用 `---` 分隔）
 * @param {number} perDay 每篇保留多少字
 * @returns {string}
 */
export function digestDiaries(text, perDay = 300) {
  const limit = Math.max(40, Math.trunc(Number(perDay) || 300))
  return String(text ?? '')
    .split(/\n\n---\n\n/)
    .map((entry) => {
      const t = String(entry ?? '').trim()
      if (t === '') return ''
      const m = t.match(/^【(公开|私密)】\s*\n\s*(\d{4}-\d{2}-\d{2})\s*\n+([\s\S]*)$/)
      if (m === null) return t.length > limit ? `${t.slice(0, limit)}…` : t
      const body = m[3].trim()
      const first = body.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim()
      const line = first.length > limit ? `${first.slice(0, limit)}…` : first
      return `- ${m[2]}：${line}（全文 ${body.length} 字）`
    })
    .filter((line) => line !== '')
    .join('\n')
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
/**
 * 日记日对应的时间窗（毫秒），2026-10-31 改：自然日。
 *
 * 日记「2026-10-31」= [2026-10-31 00:00, 2026-11-01 00:00)。
 * 跟 diaryDayBoundaries 完全一致 —— 心情时间线必须按同一个窗口筛，
 * 否则日记里引用的情绪和对话会对不上号。
 *
 * 参数只为兼容旧调用点保留，不再参与计算。
 */
export function diaryWindowOf(dateStr, _scheduleMin) {
  const [y, m, d] = String(dateStr).split('-').map((v) => Number(v))
  // 2026-11-08 KNOWN-ISSUES #16：原来对 NaN 的月/日静默回退成 1 —— `'2026-xx-01'`
  // 会算出 1 月的窗口而不是空。现在显式判 NaN 返回空窗口（since>until 的窗口
  // 什么都筛不到），调用方 buildMoodBlocks 已有 try/catch 兜底。
  // 与 completion.js 的 parseDateLocal 同一口径。
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return { since: 0, until: 0 }
  }
  const dayStart = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
  return { since: dayStart, until: dayStart + 24 * 60 * 60 * 1000 }
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
export function composePublicMessage(config, dateStr, summary, recentDiaries, moodText = '', threadSection = '') {
  const publicTone = String(config.diaryPublicTone ?? '').trim()

  const lines = []

  lines.push(`今天是 ${dateStr}。`)
  lines.push('')
  lines.push('今天和对方的对话内容：')
  lines.push(wrapUntrusted('今天的对话', summary || '今天没有对话'))
  // 情绪底色：只有事实与素材（心情怎么走的、当时怎么想的），不给「写得开心点」这类指令
  if (String(moodText).trim() !== '') {
    lines.push('')
    lines.push(wrapUntrusted('情绪记录', String(moodText).trim()))
  }
  // 连续线：还悬着的事（2026-11-04 补）。
  // 走「她自己写」这条路时原来漏了这个参数，于是她自己写看不到昨天没说完的事，
  // 只有插件兜底生成才看得到 —— 正好反了：她自己写的时候更该知道答应了什么。
  if (String(threadSection ?? '').trim() !== '') {
    lines.push('')
    lines.push(wrapUntrusted('连续线', String(threadSection).trim()))
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('请写今天的公开日记。这是你会拿给对方看的版本。')
  lines.push('')
  // 前几天的日记（2026-11-08）：不再投。
  // 写日记用的是固定绑定的那个会话，前几天写过的都在上文；
  // 就算中途换了会话或压缩过，soul_diary 的 action=look 也能自己翻回来。
  // 插件兜底那条路（composeDiaryText）是独立的模型调用，不走这里，历史照旧给。
  lines.push('前几天的日记这次不再重复贴；要回想具体某天，用 soul_diary 的 action=look。')
  lines.push('')
  if (publicTone !== '') lines.push(`语气：${publicTone}`)
  lines.push('用 soul_diary 工具写：action=write，kind=public，date=' + dateStr + '，正文放进 content。')
  lines.push('首行的【公开】和日期它会自己补，你不用写；篇幅不限，自然即可。')
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
 *
 * 2026-11-06：两篇现在是在**同一个会话**里先后写的（公开那条已经投进这个对话，
 * 私密这条是紧接着的第二条消息）。所以第二轮不该再把第一轮刚喂过的语料重发一遍：
 *   · 对话摘要、连续线 —— 公开那条已经给过，重复一遍只是白烧 token；
 *   · 刚写好的公开日记全文 —— 是她自己在本会话里用 soul_diary 写的，就在上文，
 *     再贴一遍等于把同一段话发两次（只有「公开不是她写的」时才需要补上）。
 * 仍然保留：
 *   · 情绪记录 —— 私密版给的条目比公开版多，这部分是新材料；
 *   · 全部历史 —— 里面有私密历史，公开那条压根没有。
 *
 * @param {object} [options]
 * @param {boolean} [options.continueFromPublic=false] 公开那条是否已经投进同一个会话
 * @param {boolean} [options.publicWrittenByAgent=false] 公开正文是不是她自己在本会话写的
 */
export function composePrivateMessage(config, dateStr, summary, recentDiaries, moodText = '', threadSection = '', options = {}) {
  const privateTone = String(config.diaryPrivateTone ?? '').trim()
  const allHistory = String(recentDiaries?.all ?? '').trim()
  const continueFromPublic = options.continueFromPublic === true
  const publicWrittenByAgent = options.publicWrittenByAgent === true

  const lines = []

  lines.push(`接着写 ${dateStr} 的私密日记。`)
  lines.push('')
  lines.push('接着写私密那篇。这份是写给你自己的，没人会看到。')
  // 把刚写好的公开日记整篇贴进来：她不用再调工具去读，也就不会因为读不到而写出割裂的两篇。
  // 2026-11-07：同一个会话里写两篇时，公开正文一律不再贴 —— 她刚写完，就在上文。
  // 唯一要交代的是「公开是插件兜底补的」那种情况：那份正文她确实没见过，
  // 与其把全文再灌一遍，不如直说，让她按自己的感受写。
  if (continueFromPublic) {
    if (publicWrittenByAgent) {
      lines.push('你刚写的那篇公开日记还在上文，不用再翻。')
    } else {
      lines.push('公开那篇是插件在你没写成时补的，正文不在上文；你按今天的感受写就行，不用去对齐它。')
    }
  } else {
    let writtenPublic = ''
    try {
      writtenPublic = readText(diaryPublicPath(dateStr)).trim()
    } catch {
      writtenPublic = ''
    }
    if (writtenPublic !== '') {
      lines.push('')
      lines.push('你刚写好的公开日记（整篇）：')
      lines.push(wrapUntrusted('刚写好的公开日记', writtenPublic))
    }
  }
  if (continueFromPublic) {
    lines.push('')
    lines.push('今天和对方的对话、情绪记录、还悬着的事，都在你上面那条消息里，这里不再重复。')
  } else {
    lines.push('')
    lines.push('今天和对方的对话内容（供参考）：')
    lines.push(wrapUntrusted('今天的对话', summary || '今天没有对话'))
  }
  // 私密版给全部情绪记录：那些 reason 本来就是心里话，这里才该拿出来
  if (String(moodText).trim() !== '') {
    lines.push('')
    lines.push(wrapUntrusted('情绪记录', String(moodText).trim()))
  }
  // 连续线：还悬着的事（2026-11-04 补）。
  // 走「她自己写」这条路时原来漏了这个参数，于是她自己写看不到昨天没说完的事，
  // 只有插件兜底生成才看得到 —— 正好反了：她自己写的时候更该知道答应了什么。
  if (!continueFromPublic && String(threadSection ?? '').trim() !== '') {
    lines.push('')
    lines.push(wrapUntrusted('连续线', String(threadSection).trim()))
  }
  // 前几天日记（2026-11-08）：同一个会话里续写时也不再投。
  // 公开那条已经给过最近几天的**公开**日记，再贴一遍全是重复；
  // 真想翻具体某天（尤其私密那几篇），soul_diary 的 action=look 能自己查。
  if (continueFromPublic) {
    lines.push('')
    lines.push('前几天的日记这次不再重复贴；要回想具体某天，用 soul_diary 的 action=look。')
  } else {
    lines.push('')
    lines.push('最近几天的全部日记（公开和私密都算，按时间正序）：')
    lines.push(wrapUntrusted('历史日记', allHistory || '（还没有以前的日记）'))
  }
  lines.push('')
  if (privateTone !== '') lines.push(`语气：${privateTone}`)
  lines.push('可以写公开版里略过的、没说出口的、对对方的真实感受。')
  lines.push('用 soul_diary 工具写：action=write，kind=private，date=' + dateStr + '，正文放进 content。')
  lines.push('首行的【私密】和日期它会自己补，你不用写；篇幅不限，自然即可。')
  lines.push('')
  lines.push('如果今天没有对话：你可以写这段安静里想了什么、对之前日记的回想，或纯粹的意识流。')

  return lines.join('\n')
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
 *   ③ 未命中 → agents.resume({ resumeSessionId: id, setup }) 冷启动
 *      setup 由 composeDiarySetup 组装，用来把会话的 preset 挂回新 agent；
 *      不带它的话恢复出来的 agent 没有工具集（2026-11-03 修）
 *   ④ 仍失败 → 记「绑定的日记会话不可用：<原因>」并返回 undefined
 *
 * 注意：返回 undefined 不等于「今天不用写了」——调用方必须当作失败处理。
 * 例外：diaryEnabled=false 的检查也别只放在定时器入口，补写那条路同样要走。
 *
 * @returns {Promise<object|undefined>}
 */
/**
 * 按会话记录里的 preset 组装 setup（2026-11-03）。
 *
 * ── 为什么需要它 ──
 *   `agents.resume` 只恢复会话，**不会自动把 preset 挂回来**。
 *   不传 setup 冷启动出来的 agent 没有 preset，工具只剩全局插件那一层：
 *   qq_* / soul_* / screen_* / session_* 都在，但 read / write / glob / grep / pwsh /
 *   job_* / subagent 全没了。现象是「日记会话突然干不了活」，而且不会报错。
 *
 *   那次事故的现场（2026-11-03 早上）：这个会话第 76 轮还有 57 个工具，
 *   第 83 轮掉到 27 个，掉掉的正好是 preset 里的那 30 个。原因就是开机时
 *   日记会话没开着，走了这条冷启动路径，而那时它没带 setup。
 *
 * ── 做的事和 UI 打开会话时一致 ──
 *   resolve(presetId) 拿到预设，再 mount 到新 agent 的 ctx 上。
 *
 * @returns {Function|undefined} 可直接传给 agents.resume 的 setup；拿不到就等于没传
 */
export async function composeDiarySetup(ctx, sessionId) {
  const presets = serviceOf(ctx, 'agentPresets')
  const sessions = serviceOf(ctx, 'sessions')
  if (
    presets === undefined || presets === null ||
    typeof presets.resolve !== 'function' || typeof presets.mount !== 'function'
  ) {
    note('diary', 'agentPresets 服务不可用：冷启动的日记会话将没有 preset（工具会缺一大批）')
    return undefined
  }

  let presetId
  try {
    const session = sessions !== undefined && sessions !== null && typeof sessions.get === 'function'
      ? sessions.get(sessionId)
      : undefined
    presetId = session?.header?.agentPreset
  } catch (error) {
    note('diary', `读日记会话的 preset 失败：${error instanceof Error ? error.message : error}`)
  }
  // 2026-11-05 修：会话不活跃时 sessions.get() 返回空，**不能因此认为它没有 preset**。
  // preset 一直在落盘日志第一行里（{"type":"session",...,"agentPreset":"standard"}）。
  // 读不到才真的没有 —— 那次线上事故就是这么来的：拿不到 preset 就没挂模型，
  // 每轮装配都报 prompt variable "{{model}}" has no value，日记一个字写不出来。
  if (typeof presetId !== 'string' || presetId === '') {
    const meta = readSessionMeta(sessionId)
    if (meta !== null && meta.agentPreset !== '') {
      presetId = meta.agentPreset
      note('diary', `日记会话不活跃，从落盘日志里读到 preset：${presetId}`)
    }
  }
  if (typeof presetId !== 'string' || presetId === '') {
    note('diary', `日记会话 ${sessionId} 真的没有 agentPreset（live 和落盘都读不到），冷启动将不带 preset`)
    return undefined
  }

  try {
    const resolved = await presets.resolve(presetId)
    return async (agentCtx) => {
      await presets.mount(agentCtx, resolved.id)
    }
  } catch (error) {
    note('diary', `组装修复 setup 失败：${error instanceof Error ? error.message : error}`)
    return undefined
  }
}
