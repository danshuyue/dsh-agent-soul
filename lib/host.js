/**
 * host.js —— 宿主私有字段的唯一入口 + 启动自检（2026-11-01，审计 C7）
 *
 * 为什么单独开一个文件：
 * 插件读的全是 DSH 的内部实现 —— `session.snapshotEvents`、事件正文在
 * `data.content`、`header.origin === 'subagent'`、`session.firstLiveSeq`。
 * 这些都不是公开契约，宿主一升级就可能变。
 *
 * **而且已经静默碎过一次**：正文其实在 data.content，代码写成了
 * data.message.content，可选链一路吃到 undefined，于是候选永远是 0、
 * 扫描在跑、日志一句不报 —— 看文件查不出来，只有「她怎么什么都不记得」。
 *
 * 所以这里做两件事：
 *   ① 所有私有字段只从这个文件读（要碎就碎一处，别散落六个文件）
 *   ② probeHost() 在会话第一轮做一次形状自检，**形状不对就喊出来**：
 *      写日志 + 落一个 host-probe.json，设置页亮红（api.js 读的就是它）
 *
 * 自检的判据是「能不能真的抠出文字」，不是「函数在不在」——
 * 上一次事故里函数全都在，只是返回了空串。
 */
import { existsSync, readFileSync } from 'node:fs'
import { atomicWrite, agentsDir } from './paths.js'
import { note } from './env.js'

/** 自检结果的落盘位置（api.js / 设置页读它）。 */
export const HOST_PROBE_FILE = () => `${agentsDir()}/host-probe.json`

/** 事件正文的容器：新宿主用 data，mood 那条老链路用 payload。 */
export function holderOf(event) {
  if (event === null || event === undefined) return undefined
  return event.payload !== undefined ? event.payload : event.data
}

/**
 * 抠正文。**只取 text 块**，reasoning（思考）不算正文 —— 那是在想，不是在说。
 * 拿不到就返回空串，绝不猜。
 */
export function firstTextOf(event, depth = 0) {
  const holder = holderOf(event)
  if (holder === null || holder === undefined || depth > 4) return ''
  const content = holder.content ?? holder.message?.content ?? holder.text
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') { parts.push(block); continue }
      if (block === null || block === undefined) continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join(' ').trim()
  }
  // 再往下一层（老格式 / 别的宿主写法）
  if (holder.message !== undefined) return firstTextOf({ data: holder.message }, depth + 1)
  return ''
}

/**
 * 这条会话是不是子智能体发起的（新版字段变了也算）。
 *
 * ⚠️ 只认明确的“子会话”标记，**不认 parentSessionId**：
 * 从别的会话 fork 出来的主会话很可能也带 parentSessionId，
 * 一旦把它判成子会话，记忆注入会在 index.js 里直接 return '' ——
 * 那比“子会话多注入了记忆”严重得多（整场失忆且不报错）。
 * 宁可漏判（退回旧行为），也不要误判。
 */
export function isSubagentAgent(agent) {
  const header = agent?.session?.header
  if (header === null || header === undefined) return false
  if (header.origin === 'subagent') return true
  if (header.kind === 'subagent' || header.agentKind === 'subagent') return true
  return false
}

/** 拿会话事件快照：API 不在就返回 null（调用方必须当"拿不到"处理，别当"没有事件"）。 */
export function snapshotOf(agent, from, to) {
  const session = agent?.session
  if (session === null || session === undefined) return null
  if (typeof session.snapshotEvents !== 'function') return null
  try {
    const list = to === undefined ? session.snapshotEvents(from) : session.snapshotEvents(from, to)
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

/**
 * 自检要看的区间：**不要从 0 开始**。
 *
 * `snapshotEvents(0)` 在压缩/继承会话上可能越界抛错，而且会把整场历史全拷一遍 ——
 * 这是每轮都走的同步装配路径，长会话（几千条）会卡一下。
 * 取最近 200 条足够验证形状，也避开了"从 0 取"这种边界。
 */
function probeWindowOf(session) {
  const seq = Number(session?.seq)
  const firstLive = Number.isFinite(Number(session?.firstLiveSeq)) ? Number(session.firstLiveSeq) : 0
  const from = Math.max(0, firstLive, Number.isFinite(seq) ? seq - 200 : 0)
  const to = Number.isFinite(seq) ? seq + 1 : undefined
  return { from, to }
}

/** 继承来的历史起点（拿不到就 0，等价于"从头发"）。 */
export function firstLiveSeqOf(agent) {
  const value = agent?.session?.firstLiveSeq
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 形状自检。返回 { ok, checks }：
 *   ok === true   形状是对的
 *   ok === false  确实坏了（该亮红灯）
 *   ok === null   **未判定**（会话刚开、还没有事件）—— 不能算绿，否则任何新会话
 *                 首轮都能把别的会话留下的红灯撤掉，红灯就不可信了
 *
 * @param extractText 必须传**真正在用的那个抽取函数**（extract.js 那套）。
 *   这里默认用本文件的 firstTextOf，但那是给自检用的容错版本 ——
 *   真正干活的是 extract.js 的 messageContentOf + textOfContent。
 *   两边一分叉，自检通过而提取照样失败，等于白查（这正是要防的那种"查不出来"）。
 * @param classify 可选，判断「这条是不是真人消息且认得出来」。注入事件本身也是
 *   user/message 且带正文，只看"能不能抠出字"会把注入的消息当成证据 ——
 *   真人那条链路改名后自检全绿、候选恒 0，正是要防的漏报。
 */
export function probeHost(agent, { extractText = firstTextOf, classify = null } = {}) {
  const session = agent?.session
  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok: ok === true, detail })

  add('session.snapshotEvents', typeof session?.snapshotEvents === 'function',
    '没有这个函数就拿不到任何事件')
  // header.id 改名是最可能的宿主变更之一。extract.js 早就写了 `header?.id ?? session?.id`
  // 的兜底，自检必须跟上 —— 否则这条检查永远走不到（拿不到 id 时 probeHostOnce 直接跳过）。
  const headerId = session?.header?.id
  const fallbackId = session?.id
  add('session.header.id', (typeof headerId === 'string' && headerId !== '')
    || (typeof fallbackId === 'string' && fallbackId !== ''),
    '会话 id 拿不到（header.id 也没有 session.id 兜底），粘性状态和"已说过"集合会串会话')

  const { from, to } = probeWindowOf(session)
  const sample = snapshotOf(agent, from, to)
  add('snapshotEvents 返回数组', sample !== null, '返回的不是数组或调用抛错（宿主改了签名？）')

  let undetermined = false
  if (sample !== null && sample.length === 0) {
    // 0 条事件：可能只是会话刚开。但 seq 已经走过了却取不到事件 → 一定是坏了
    const seq = Number(session?.seq)
    if (Number.isFinite(seq) && seq > 0) {
      add('事件可取到', false, 'seq 已经推进了，快照却是空的（区间/签名变了？）')
    } else {
      undetermined = true // 还没有事件，判不了，不能算绿
    }
  }

  if (sample !== null && sample.length > 0) {
    const messageLike = sample.filter((event) => String(event?.type ?? event?.kind ?? '').endsWith('/message'))
    const withText = sample.filter((event) => extractText(event) !== '')

    if (messageLike.length === 0) {
      // 2026-11-01 线上假红灯：刚重启的会话，快照里只有 4 条非消息事件，
      // 于是「一条正文都抠不出来」直接失败 —— 可真实提取一直是好的。
      //
      // 样本里**根本没有消息类事件**时判不了，只能是「未判定」。
      // 但样本够大（≥10 条）却一条消息类事件都没有，那就不是"还没开始聊"，
      // 而是消息事件类型改名了 —— 这种仍要报，否则 C7 的漏报又回来了。
      if (sample.length >= 10) {
        add('消息事件存在', false, `${sample.length} 条事件里没有一条消息类事件（type 可能改名了）`)
      } else {
        undetermined = true
      }
    } else {
      // ⭐ 最要紧的一条：有消息事件但一条正文都抠不出来 = 当年那次静默失效的形状
      add('事件正文可解析', withText.length > 0,
        `${sample.length} 条事件里一条正文都抠不出来（正文位置可能变了）`)
      add('消息事件带正文', messageLike.some((event) => extractText(event) !== ''),
        'message 类型的事件里没有能用的正文')
    }

    // 只在「样本里确实有真人消息」时才要求 classify 认得出：
    // 一条真人消息都没有（比如首轮全是注入）就不判，免得开个假红灯。
    if (typeof classify === 'function') {
      const humanLike = sample.filter((event) => String(holderOf(event)?.source?.kind ?? '') === 'user')
      if (humanLike.length > 0) {
        add('真人消息可识别', humanLike.some((event) => classify(event) === true),
          `有 ${humanLike.length} 条 source.kind=user 的事件，一条都没被提取链认出来`)
      }
    }
  }

  const allOk = checks.every((check) => check.ok === true)
  const ok = allOk === false ? false : (undetermined === true ? null : true)
  return { ok, checks }
}

/** 有 id 的会话按 id 去重；拿不到 id 的按对象去重（WeakSet，不泄漏）。 */
const probed = new Set()
let probedWeak = new WeakSet()

/** 每个会话自检一次；坏了就喊（日志 + 落盘给设置页）。 */
export function probeHostOnce(agent, options = {}) {
  const session = agent?.session
  const id = String(session?.header?.id ?? session?.id ?? '')
  if (id !== '') {
    if (probed.has(id)) return null
    // 超限删最旧，别 clear()：一 clear，正在跑的长会话下一轮会被当成新会话重扫一遍
    if (probed.size > 200) {
      const oldest = probed.values().next().value
      if (oldest !== undefined) probed.delete(oldest)
    }
    probed.add(id)
  } else if (session !== null && typeof session === 'object') {
    // 连 id 都拿不到也要照常自检 —— 让上面那条检查自己报出来，而不是静默返回
    if (probedWeak.has(session)) return null
    probedWeak.add(session)
  } else {
    return null
  }

  let result
  try {
    result = probeHost(agent, options)
  } catch (error) {
    // 自检自己炸了：这是「未判定」，不该指向某个具体字段
    result = { ok: null, checks: [{ name: '自检本身', ok: false, detail: String(error?.message ?? error) }] }
  }
  // 未判定：不写盘、也不撤灯；**并且把会话从"查过了"里放回去**，
  // 否则会话刚开那一下判完就再也不查了（等于永远没查过）。
  if (result.ok === null) {
    if (id !== '') probed.delete(id)
    return result
  }

  if (result.ok === true) {
    // 一切正常就把旧的红灯撤掉（宿主升级后恢复正常，不能一直红着）
    try {
      if (existsSync(HOST_PROBE_FILE())) atomicWrite(HOST_PROBE_FILE(), '')
    } catch { /* 清不掉就算了，下次还会再试 */ }
    return result
  }

  const failed = result.checks.filter((check) => check.ok !== true)
  note('host', `⚠️ 宿主形状自检没过：${failed.map((c) => `${c.name}（${c.detail}）`).join('；')}`)
  note('host', '⚠️ 后果：记忆/心情提取会**静默失效**（扫描在跑、候选恒 0、日志不报）。'
    + '去 lib/extract.js 的 messageContentOf / lib/host.js 的 firstTextOf 里改事件形状。')
  try {
    atomicWrite(HOST_PROBE_FILE(), `${JSON.stringify({
      at: new Date().toISOString(),
      sessionId: id,
      failed: failed.map((check) => ({ name: check.name, detail: check.detail }))
    }, null, 2)}\n`)
  } catch { /* 落不了盘也不影响喊出来 */ }
  return result
}

/** 设置页用：上次自检失败留下的现场（没有 / 空文件 → null）。 */
export function hostProbeState() {
  try {
    const file = HOST_PROBE_FILE()
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8').trim()
    if (raw === '') return null
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 测试用。 */
export function __resetHostProbeForTest() {
  probed.clear()
  probedWeak = new WeakSet()
}
