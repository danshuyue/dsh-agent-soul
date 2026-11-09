/**
 * 日记 · llm.js（2026-11-10 KNOWN-ISSUES #27：由 compose.js 按职责拆出）
 * LLM 调用块：describeFinishReason / summarizeConversations / composeDiaryText。
 * 函数体逐字未改；prompt 组装仍在 compose.js，最近日记读取在 history.js，
 * 会话 preset 修复在 agent.js。对外仍走 lib/diary.js 门面，导出集合不变。
 */
import { DATA_BOUNDARY_POLICY, wrapUntrusted } from '../core/prompt-guard.js'
import { consumeLlmStream } from '../core/llm-stream.js'
import { note } from '../env.js'
import { randomUUID } from 'node:crypto'
import { sessionModelOf } from '../mood/session.js'


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
 * ⚠️ 已废弃（2026-11-09 KNOWN-ISSUES #34）：日记主流程不再走它（scheduler.js
 * 现在直接用 composeDiaryText 组装），导出只为兼容旧调用方/测试
 * （tests/diary.test.js 仍在测它）。新代码**不要**调用；等测试迁移后连门面
 * 导出一起删。
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
  // 现实情境（2026-11-09 R19 / ④）：只作**背景事实**递过去，不写成指令。
  // 「一旦让她照着情绪演，日记就假了」—— 这里同理：给「那天是国庆、已经三天没聊」，
  // 不给「你要写得温暖一点」。关掉 situationEnabled 时这里的数组是空的 → 逐字节等价。
  const facts = Array.isArray(ctx.situation)
    ? ctx.situation.map((f) => String(f ?? '').trim()).filter((f) => f !== '')
    : []
  if (facts.length > 0) lines.push(`（背景：${facts.join('；')}。）`)
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
