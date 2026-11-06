/**
 * 心情引擎 · judge.js
 * 由 lib/mood.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { buildJudgeSystem, talkSupplement, workSupplement } from './prompt.js'
import { consumeLlmStream } from '../core/llm-stream.js'
import { loadSecret } from '../core/secrets.js'
import { parseDelta } from './core.js'
import { randomUUID } from 'node:crypto'
import { sessionModelOf } from './session.js'
import { wrapUntrusted } from '../core/prompt-guard.js'


// --------------------------------------------------------------------------
// 判断：用 DSH 自己的模型（一次很短的调用）
// --------------------------------------------------------------------------

/** 单次心情判断的硬上限（毫秒）。超过就放弃这一轮，别把整条判断链堵死。 */
const JUDGE_TIMEOUT_MS = 25000


const SILICONFLOW_URL = 'https://api.siliconflow.cn/v1/chat/completions'


/** 「没找到密钥」只提示一次（每回合都提示会把 soul.log 淹掉）。 */
let missingKeyNoted = false


/**
 * 走硅基流动的 OpenAI 兼容接口判心情（2026-11-01）。
 *
 * 为什么另开一条 HTTP 路：小模型（Qwen2.5-7B 这一档）判这种「读一轮对话、
 * 吐一个 JSON」的活已经够用，成本却只有旗舰模型的零头 —— 而这活儿每回合都要跑一次。
 * 宿主的 llm 服务不认第三方 provider，所以直接打 HTTP。
 *
 * 失败一律返回 null（= 这轮不记账），绝不抛到 judgeChain 外面把整条链炸掉。
 */
async function judgeViaSiliconFlow(key, model, sys, user, o, note) {
  try {
    const signal = typeof AbortSignal?.timeout === 'function'
      ? AbortSignal.timeout(JUDGE_TIMEOUT_MS)
      : undefined
    const res = await fetch(SILICONFLOW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ],
        max_tokens: 400,
        temperature: 0.2
      }),
      signal
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (note) note('mood', `硅基流动返回 ${res.status}：${String(body).slice(0, 160)}`)
      return null
    }
    const data = await res.json()
    const text = String(data?.choices?.[0]?.message?.content ?? '')
    return parseDelta(text, o.owner)
  } catch (error) {
    if (note) note('mood', `硅基流动调用失败：${error?.message ?? error}`)
    return null
  }
}


/**
 * 判一轮的心情变化。返回 delta（parseDelta 的形状）或 null。
 *
 * @param llm   宿主的 llm 服务（ctx.llm）
 * @param agent 当前会话的 agent（用来跟随会话模型）
 * @param userText 对方这轮说的话
 * @param reply    她这轮说的话
 * @param mode  '' | 'work' | 'talk'
 * @param o     { self, owner, aliases, judgeProvider, judgeModel }
 * @param note  可选的日志函数（纯逻辑模块不 import env，由调用方注入）
 */
export async function judgeMood(llm, agent, userText, reply, mode, o, note) {
  let sys = buildJudgeSystem(o)
  let user
  if (mode === 'work') {
    sys += workSupplement(o)
    // 她的话摆最前面、闹钟塞到最后一行括号里 —— 顺序就是权重，别让模型拿闹钟当理由
    // 2026-11-05 S2 / P1-4：reply / userText 都是可写进会话的文本，包数据边界；
    // 指令句留在标签外，避免模型把数据里的「请输出…」当成新任务。
    user = '⚠️ 这一轮**不是' + (o.owner || '对方') + '在跟你说话**，是定时任务把你叫起来干活的。\n\n'
      + '**你这轮说的话（唯一判据，重点看这个）：**\n' + wrapUntrusted('她的回复', String(reply || '').slice(0, 1200))
      + '\n\n（下面这条只是闹钟，跟心情无关，别拿它当理由：「' + wrapUntrusted('闹钟', String(userText || '').slice(0, 100)) + '」）'
      + '\n\n请判断**你自己这轮的心情变化**，只输出 JSON。'
  } else if (mode === 'talk') {
    sys += talkSupplement(o)
    user = '⚠️ 这一轮**不是' + (o.owner || '对方') + '在跟你说话，是你自己主动去找' + (o.owner || '对方') + '搭话的**。\n\n'
      + '**你开口说的话（唯一判据，重点看这个）：**\n' + wrapUntrusted('她的回复', String(reply || '').slice(0, 1200))
      + '\n\n（下面这条只是叫你开口的闹钟，跟心情无关，别拿它当理由：「' + wrapUntrusted('闹钟', String(userText || '').slice(0, 100)) + '」）'
      + '\n\n请判断**你自己这轮的心情变化**，只输出 JSON。'
  } else {
    // 她的回复同样是判据，而且往往更直接（念叨吃饭、凶人、哄人、撒娇都在里面）
    user = '**你这轮说的话（判据之一，重点看语气：是念叨、心疼、凶' + (o.owner || '对方') + '、还是撒娇）：**\n'
      + wrapUntrusted('她的回复', String(reply || '').slice(0, 1500))
      + '\n\n' + (o.owner || '对方') + '这轮说：\n' + wrapUntrusted('对方的话', String(userText || '').slice(0, 1600))
      + '\n\n请把「你怎么说的」和「' + (o.owner || '对方') + '说了什么」合起来判断你的心情变化，只输出 JSON。'
  }
  // ① 配了硅基流动就直接走它的 HTTP API（自己的密钥、自己的小模型）。
  //    宿主的 llm 服务只认得它自己注册过的 provider，硅基流动不在里面，
  //    所以这条路不经过 llm.stream —— 跟日记那条「自己调模型」是同一个思路。
  if (o.judgeProvider === 'siliconflow' && o.judgeModel) {
    const key = loadSecret('siliconflow')
    if (key) return judgeViaSiliconFlow(key, o.judgeModel, sys, user, o, note)
    // 只在第一次说，不要每回合刷一行（那会把 soul.log 淹掉）
    if (note && missingKeyNoted === false) {
      missingKeyNoted = true
      note('mood', '配了硅基流动但没找到密钥（~/.dsh/agents/secrets/siliconflow.bin），退回会话模型')
    }
  }

  // ② 其余情况走宿主的 llm 服务
  if (!llm || typeof llm.stream !== 'function') return null
  const picked = (o.judgeProvider && o.judgeModel) ? { provider: o.judgeProvider, model: o.judgeModel } : null
  const target = picked || sessionModelOf(agent)
  if (!target) return null

  // 自己构造一条 user 消息（不 import @deepseek-ai/dsh-llm，跟 feiyu-mood 同款）
  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: user }],
    source: { kind: 'plugin', plugin: 'dsh-agent-soul' },
  }]
  // 2026-11-05 修 P2-11：超时保护下沉到 iterator.next()，超时会主动关迭代器。
  // 原来只在 IIFE 外层 race，网络挂起时后台那条流永远不结束，judgeChain 之后
  // 每轮再开一条 —— 表现就是「心情从某一刻起再也不动了」且宿主并发被吃光。
  // o.judgeTimeoutMs 是给回归用例留的注入口，正常路径仍用 JUDGE_TIMEOUT_MS。
  const streamed = await consumeLlmStream(llm, {
    provider: target.provider,
    model: target.model,
    system: sys,
    messages,
    // maxTokens 400 太小：reason 是中文口语，一长就被切在 JSON 中间 ⇒ 整轮白判。
    // 调大不花钱：maxTokens 只是上限，按实际吐出来的算。
    maxTokens: 1000,
    temperature: 0.2,
  }, { timeoutMs: Number(o?.judgeTimeoutMs) || JUDGE_TIMEOUT_MS })
  if (!streamed.ok) {
    // 静默失败会让「心情停住不动」毫无线索：至少留一行日志，诊断时不至于全靠猜。
    // 模型自己报 error finish 时沿用旧行为（不记日志、直接丢这轮）。
    if (note && streamed.error !== '') note('mood', `判断调用失败：${streamed.error}`)
    return null
  }
  // 2026-11-06 审计 P2-11：解析失败原来是**完全静默**的 —— parseDelta 返回 null，
  // judgeMood 直接把这轮丢掉，日志里一个字都没有。表现是「心情从某轮起不动了」，
  // 和 hooks.js 里「静默失败会让心情停住毫无线索」那句注释自相矛盾。
  // 只记长度与哈希，不记原话（心情判定会看到对话内容）。
  const parsed = parseDelta(streamed.text, o.owner)
  if (parsed === null && note) {
    const text = String(streamed.text ?? '')
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    note('mood', `判断结果不是 JSON，本轮跳过：${text.length} 字 #${hash.toString(36)}；原文不落日志`)
  }
  return parsed
}
