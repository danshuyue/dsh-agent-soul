/**
 * 心情引擎 · session.js
 * 由 lib/mood.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { EXTERNAL_TRIGGER, INJECTED_CONTEXT, MACHINE_PREFIXES, MACHINE_SOURCES, SELF_SPEAK } from './prompt.js'


// --------------------------------------------------------------------------
// 消息抽取（宿主事件形状的容错，移植自 dsh-feiyu-mood）
// --------------------------------------------------------------------------

/**
 * 从一条消息里抠正文。不截断（要截断的地方自己截）。
 * ⭐ 正文在 data.message.content 里；reasoning（思考）不算正文 —— 那是在想，不是在说。
 */
export function fullTextOf(p, depth = 0) {
  if (!p || depth > 6) return ''
  if (typeof p === 'string') return p
  if (typeof p.text === 'string' && Array.isArray(p.content) === false && !p.message) return p.text
  if (typeof p.content === 'string') return p.content
  if (p.message && typeof p.message === 'object') {
    const inner = fullTextOf(p.message, depth + 1)
    if (inner) return inner
  }
  if (Array.isArray(p.content)) {
    const body = []
    const thinking = []
    for (const block of p.content) {
      if (typeof block === 'string') { body.push(block); continue }
      if (!block) continue
      if (block.type === 'text' && typeof block.text === 'string') body.push(block.text)
      else if (block.type === 'reasoning' && typeof block.text === 'string') thinking.push(block.text)
      else if (typeof block.text === 'string' && block.type === undefined) body.push(block.text)
    }
    if (body.length) return body.join(' ')
    if (thinking.length) return thinking.join(' ')
  }
  if (typeof p.text === 'string') return p.text
  return ''
}


export function textOfMessage(p) {
  return fullTextOf(p).slice(0, 2000)
}


/**
 * 网桥投递的消息 = ［身份］［人设］示例对白 …【主人私信】<真人原话> … 任务指令。
 * 人设在前、原话在很后面 —— 从最后一个投递标记切到正文，别让判断模型只看到人设。
 */
export function stripBridgePrefix(s) {
  const t = String(s || '')
  const marks = ['【主人私信】', '【私信】', '【评论】', '【弹幕】', '【@']
  let last = -1
  let len = 0
  for (const m of marks) {
    const i = t.lastIndexOf(m)
    if (i > last) { last = i; len = m.length }
  }
  if (last < 0) return t
  let after = t.slice(last + len).replace(/^[）)\]】\s]*/, '')
  // 标记后面常跟一小段「谁发的」说明（冒号前那截够短又明显是说明），再切一刀
  const colon = after.slice(0, 80).search(/[：:]/)
  if (colon > 0 && /mid\s*\d+|私信|消息/i.test(after.slice(0, colon))) after = after.slice(colon + 1)
  return after.trim() || t
}


// 2026-11-04：导出给测试用（soul-tone 必须被判成机器来源，否则心情判定会自己喂自己）
export const isMachineSource = (src) => {
  if (!src) return false
  if (MACHINE_SOURCES.has(src)) return true
  const low = String(src).toLowerCase()
  return MACHINE_PREFIXES.some((p) => low.startsWith(p))
}


/**
 * 返回 { text, sourceKind }：从最后往前找第一条真人/真触发的消息。
 * 跳过宿主注入的上下文与机器来源；定时任务/主动搭话保留来源以便选判断口径。
 */
export function lastUserTurnOf(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return null
    const events = session.snapshotEvents() || []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]
      if ((e && (e.type || e.kind)) !== 'user/message') continue
      const p = e.payload !== undefined ? e.payload : e.data
      const txt = stripBridgePrefix(fullTextOf(p)).slice(0, 1600)
      if (!txt) continue
      const src = p && p.source && p.source.kind ? String(p.source.kind) : ''
      if (INJECTED_CONTEXT.has(src)) continue
      if (EXTERNAL_TRIGGER.has(src) || SELF_SPEAK.has(src)) return { text: txt, sourceKind: src }
      if (isMachineSource(src)) continue
      // 桥进来的话 = 对方在说话；没见过的来源先按人说话处理（免得把某座桥漏掉）
      // 走到这里说明来源既不是宿主注入的上下文、也不是定时任务/主动搭话，
      // 那就是人说的（本地会话或某座桥）。
      // 原来这里写的是 `BRIDGE_SOURCES.has(src) ? 'user' : (src && src !== 'user' ? 'user' : 'user')`
      // —— 三个分支全返回 'user'，纯废代码，容易让人以为还有什么区分逻辑。
      return { text: txt, sourceKind: 'user' }
    }
  } catch { /* 读不到就算了 */ }
  return null
}


/** 最后一条她自己说的话（判断的直接情绪证据）。 */
export function lastAssistantTextOf(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return ''
    const events = session.snapshotEvents() || []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]
      if ((e && (e.type || e.kind)) !== 'assistant/message') continue
      const p = e.payload !== undefined ? e.payload : e.data
      const txt = textOfMessage(p)
      if (txt) return txt
    }
  } catch { /* ignore */ }
  return ''
}


/** 跟随当前会话的模型（没指定判断模型时用）。 */
export function sessionModelOf(agent) {
  try {
    const h = agent && agent.session && agent.session.requestHeader ? agent.session.requestHeader() : null
    const cfg = h && h.config
    if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  } catch { /* ignore */ }
  try {
    const o = agent && agent.options
    if (o && o.provider && o.model) return { provider: o.provider, model: o.model }
  } catch { /* ignore */ }
  return null
}
