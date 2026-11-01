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
  const list = to === undefined ? session.snapshotEvents(from) : session.snapshotEvents(from, to)
  return Array.isArray(list) ? list : null
}

/** 继承来的历史起点（拿不到就 0，等价于"从头发"）。 */
export function firstLiveSeqOf(agent) {
  const value = agent?.session?.firstLiveSeq
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 形状自检。返回 { ok, checks }，checks 里每一项都是「能不能用」，不是「字段在不在」。
 *
 * 只在会话第一轮跑一次，所以可以多花几毫秒。
 *
 * @param extractText 必须传**真正在用的那个抽取函数**（extract.js 那套）。
 *   这里默认用本文件的 firstTextOf，但那是给自检用的容错版本 ——
 *   真正干活的是 extract.js 的 messageContentOf + textOfContent。
 *   两边一分叉，自检通过而提取照样失败，等于白查（这正是要防的那种"查不出来"）。
 */
export function probeHost(agent, { extractText = firstTextOf } = {}) {
  const session = agent?.session
  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok: ok === true, detail })

  add('session.snapshotEvents', typeof session?.snapshotEvents === 'function',
    '没有这个函数就拿不到任何事件')
  add('session.header.id', typeof session?.header?.id === 'string' && session.header.id !== '',
    '会话 id 拿不到，粘性状态和"已说过"集合会串会话')

  const sample = snapshotOf(agent, 0)
  add('snapshotEvents 返回数组', sample !== null, '返回的不是数组（宿主改了签名？）')

  if (sample !== null && sample.length > 0) {
    const withText = sample.filter((event) => extractText(event) !== '')
    // ⭐ 最要紧的一条：有事件但一条正文都抠不出来 = 当年那次静默失效的形状
    add('事件正文可解析', withText.length > 0,
      `${sample.length} 条事件里一条正文都抠不出来（正文位置可能变了）`)
    const messageLike = sample.filter((event) => String(event?.type ?? '').endsWith('/message'))
    if (messageLike.length > 0) {
      add('消息事件带正文', messageLike.some((event) => extractText(event) !== ''),
        'message 类型的事件里没有能用的正文')
    }
  }

  return { ok: checks.every((check) => check.ok === true), checks }
}

const probed = new Set()

/** 每个会话自检一次；坏了就喊（日志 + 落盘给设置页）。 */
export function probeHostOnce(agent, options = {}) {
  const id = String(agent?.session?.header?.id ?? '')
  if (id === '') return null
  if (probed.has(id)) return null
  if (probed.size > 200) probed.clear()
  probed.add(id)

  let result
  try {
    result = probeHost(agent, options)
  } catch (error) {
    result = { ok: false, checks: [{ name: '自检本身', ok: false, detail: String(error?.message ?? error) }] }
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
}
