/**
 * refine.js —— 把「主人说的原话」交给模型，提炼成一条条真正的记忆。
 *
 * ── 为什么必须有这一层 ──
 * 自动提取原来是把原话直接塞进记忆卡（extract.js 里 `text: candidate.text`）。
 * 2026-10-30 实测的三条"记忆"长这样：
 *   （QQ 私聊·用户本人 [QQ号]）起了起了
 *   （QQ 私聊·用户本人 [QQ号]）唔…早上好喵~
 *   （主动搭话：距上次说话已经 6 小时 3 分钟。…就 qq_pass…）
 * 前两条一条是主人的废话、一条是她自己的话，第三条压根是桥的触发模板。
 * 这叫存档，不叫记忆。
 *
 * 记忆该长这样：「树树是烟台大学机器人工程专业大二学生」——
 * 是**提炼过的事实**，不是"他当时说了什么"。所以这里加一次很短的模型调用。
 *
 * ── 三个刻意的设计 ──
 *   1. 一批一次调用（最多 8 条原话），不是一条一次 —— 省 token，也让模型能合并。
 *   2. 没有信息量就输出空数组：**宁可少记**。记忆是有限预算，塞满废话最糟。
 *   3. 失败不丢数据：调用失败/超时/解析不出，调用方退回"原话直存"的老路径。
 */
import { randomUUID } from 'node:crypto'
import { sessionModelOf } from './mood.js'

/** 提炼调用上限（毫秒）。超时就退回原话，别把记忆这条线堵死。 */
const REFINE_TIMEOUT_MS = 30000

/** 一次最多送几条原话进去（再多模型容易挑花眼、也容易编）。 */
const MAX_INPUT = 8

/**
 * 提炼用的系统提示词。
 *
 * 要「写成记忆」而不是「复述对话」——这是这层存在的全部意义，所以例子给足。
 */
export function buildRefineSystem({ owner = '主人' } = {}) {
  return `你在帮忙整理记忆。下面是${owner}刚说过的话（可能夹杂桥接前缀、口癖、错别字、断句）。
请把其中有价值的信息提炼成一条条**记忆**，只输出一个 JSON 数组，不要任何别的字、不要 markdown 代码块。

每条格式：{"text":"…","importance":60,"kind":"fact"}

规则：
1. 写成**关于${owner}的一条记忆**：用「${owner}」指代他，用「我」指代你自己。
   ✅「${owner}是烟台大学机器人工程专业大二学生」
   ✅「${owner}的目标是当嵌入式工程师，偏软件方向」
   ✅「答应过${owner}，以后提醒他别熬夜」
   ❌「${owner}说他是大二的」← 这是复述，不是记忆
   ❌「用户表示……」← 别用"用户"，太生分
2. 一条只讲一件事，每条 40 字以内。两件不相干的事要拆成两条。
3. kind 取值：
   · fact —— 身份 / 专业 / 学校 / 目标 / 长期习惯（这类最值钱）
   · preference —— 明确的喜好、厌恶、口味、雷区
   · promise —— 约定、以后要做的事
   · event —— 最近发生的事（带时间感）
   · feeling —— 他的情绪或状态（累、烦、开心）
4. importance（0~100）：
   · 身份 / 专业 / 目标 / 长期习惯 → 75~90
   · 明确偏好 / 约定 → 65~80
   · 最近发生的事 / 情绪状态 → 45~64
5. ⭐ **没有信息量就输出空数组 []**。寒暄、语气词、「嗯」「好的」「起了起了」这种，
   一条都不要输出。宁可少记，也不要为了完成任务硬凑 —— 记忆位置有限，塞满废话最糟。
6. 不要编：他没说的事一律不写；拿不准就写模糊一点（「最近在学单片机」而不是「在学 STM32H743」）。`
}

/** 用户消息：把候选原话按顺序编号列出来。 */
export function buildRefineUser(candidates, { owner = '主人' } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, MAX_INPUT)
  const lines = list.map((item, index) => `${index + 1}. ${String(item?.text ?? '').slice(0, 300)}`)
  return `${owner}这段时间说的话（按时间顺序）：\n${lines.join('\n')}\n\n请提炼成记忆，只输出 JSON 数组。`
}

/**
 * 解析模型输出 → 记忆条目。
 *
 * 容错三处（都是实测会遇到）：markdown 代码块包着、前后带解释、单条而不是数组。
 * 解析不出就返回 null —— 调用方据此退回原话直存，不能因为格式问题把信息丢了。
 */
export function parseRefined(text, { max = MAX_INPUT } = {}) {
  const raw = String(text ?? '').trim()
  if (raw === '') return null

  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  let list = null
  if (start >= 0 && end > start) {
    try {
      list = JSON.parse(raw.slice(start, end + 1))
    } catch {
      list = null
    }
  }
  if (list === null) {
    // 有的模型会只给一个对象
    const os = raw.indexOf('{')
    const oe = raw.lastIndexOf('}')
    if (os >= 0 && oe > os) {
      try {
        const one = JSON.parse(raw.slice(os, oe + 1))
        list = [one]
      } catch {
        return null
      }
    }
  }
  if (!Array.isArray(list)) return null

  const KINDS = new Set(['fact', 'preference', 'promise', 'event', 'feeling'])
  const out = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const body = String(item.text ?? '').trim()
    if (body.length < 4) continue
    const importance = Number(item.importance)
    out.push({
      text: body.slice(0, 200),
      importance: Number.isFinite(importance) ? Math.min(100, Math.max(0, Math.round(importance))) : 55,
      kind: KINDS.has(String(item.kind)) ? String(item.kind) : 'event'
    })
    if (out.length >= max) break
  }
  return out
}

/**
 * 调一次模型做提炼。
 *
 * @returns {Promise<Array|null>} 条目数组；任何失败都返回 null（调用方退回原话）
 */
export async function refineCandidates(llm, agent, candidates, {
  note,
  owner = '主人',
  provider = '',
  model = '',
  timeoutMs = REFINE_TIMEOUT_MS
} = {}) {
  if (!llm || typeof llm.stream !== 'function') return null
  const list = (Array.isArray(candidates) ? candidates : []).filter((item) => String(item?.text ?? '').trim() !== '')
  if (list.length === 0) return []

  const picked = (provider && model) ? { provider, model } : null
  const target = picked || sessionModelOf(agent)
  if (!target) return null

  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: buildRefineUser(list, { owner }) }],
    source: { kind: 'plugin', plugin: 'dsh-agent-soul' }
  }]

  let out = ''
  let timer = null
  try {
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`提炼超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs)
      if (timer !== null && typeof timer.unref === 'function') timer.unref()
    })
    const consume = (async () => {
      for await (const chunk of llm.stream({
        provider: target.provider,
        model: target.model,
        system: buildRefineSystem({ owner }),
        messages,
        maxTokens: 900,
        // 带一点温度：提炼要改写，太死板会照抄原话
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
  } catch (error) {
    if (note) note('memory', `提炼调用失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }

  const parsed = parseRefined(out)
  if (parsed === null && note) note('memory', '提炼结果解析不出 JSON，退回原话直存')
  return parsed
}
