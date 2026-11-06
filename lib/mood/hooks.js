/**
 * 心情引擎 · hooks.js
 * 由 lib/mood.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { DIMS, moodStepOf } from './core.js'
import { EXTERNAL_TRIGGER, INJECTED_CONTEXT, SELF_SPEAK } from './prompt.js'
import { judgeMood } from './judge.js'
import { lastAssistantTextOf, lastUserTurnOf, textOfMessage } from './session.js'


// --------------------------------------------------------------------------
// 每轮钩子：懒挂 agent 的 turn-stopping（挂一次就够）
// --------------------------------------------------------------------------

/**
 * agent -> { offs }。**必须是 WeakMap**：agent 身上挂着整个会话的事件历史，
 * 用普通 Map 强引用它就永远回收不掉 —— 会话开了又关，内存只涨不降。
 * 但 WeakMap 不可遍历，unobserveAll 又需要全量拆掉，所以另留一个只存 `{ offs }`
 * 的 Set：它不引用 agent，只是记录有哪些监听还挂着。
 */
const mounted = new WeakMap()

const mountedOffs = new Set()

let judgeChain = Promise.resolve() // 判断串行，避免多轮堆积互相覆盖


/**
 * 观察一个 agent：每轮结束判断一次心情（异步，不阻塞对话）。
 * 幂等：同一个 agent 只挂一次。config 是函数（现读，设置改完立刻生效）。
 */
export function observeAgent(agent, { llm, config, note }) {
  if (!agent || mounted.has(agent)) return
  if (!agent.ctx || typeof agent.ctx.on !== 'function') {
    if (note) note('mood', 'agent 没有事件总线，心情判断未挂载')
    return
  }
  const offs = []
  let lastText = ''
  let lastSrc = ''
  const names = () => {
    const cfg = config()
    return {
      self: cfg.moodSelfName,
      // 2026-11-04：主人名字/性别/关系一律走配置，空值时提示词整句省略。
      owner: cfg.ownerName,
      ownerName: cfg.ownerName,
      gender: cfg.ownerGender,
      relationship: cfg.relationship,
      aliases: cfg.moodSelfAliases,
      judgeProvider: cfg.moodJudgeProvider,
      judgeModel: cfg.moodJudgeModel,
    }
  }

  // 1) 收这一轮对方说的话（宿主注入的上下文不算）
  try {
    offs.push(agent.ctx.on('agent/inbox/inserted', (payload) => {
      const msg = payload && payload.message ? payload.message : payload
      const txt = textOfMessage(msg)
      const src = msg && msg.source && msg.source.kind ? String(msg.source.kind) : ''
      if (!txt || INJECTED_CONTEXT.has(src)) return
      lastText = txt
      lastSrc = src
    }))
  } catch (e) {
    if (note) note('mood', `监听 inbox 失败：${e instanceof Error ? e.message : e}`)
  }

  // 2) 这轮结束 → 判断心情（异步，不阻塞对话）
  try {
    offs.push(agent.ctx.on('agent/turn-stopping', () => {
      const cfg = config()
      if (cfg.moodEnabled === false) return
      // 以会话事件为准（带 source.kind），拿不到才退回 inbox 缓存
      const info = lastUserTurnOf(agent.session) || (lastText ? { text: lastText, sourceKind: lastSrc } : null)
      if (!info || !info.text) return
      const reply = lastAssistantTextOf(agent.session)
      const kind = String(info.sourceKind || '')
      const mode = EXTERNAL_TRIGGER.has(kind) ? 'work' : (SELF_SPEAK.has(kind) ? 'talk' : '')
      judgeChain = judgeChain
        .then(async () => {
          const delta = await judgeMood(llm, agent, info.text, reply, mode, names(), note)
          if (!delta) return
          const anyDim = DIMS.some(([k]) => delta.dims[k] !== 0)
          // 2026-11-06 审计 P0-2：和 core.applyDelta 用**同一个**步长函数。
          // 原来这里各写一遍 `Math.round(delta.moodDelta / 3)`，±1 都变成 0，
          // 于是判定模型按 prompt 给的 -1 既不记账也不动数值 —— 两处口径必须共享。
          const step = moodStepOf(delta.moodDelta)
          if (step === 0 && !anyDim) return // 一点变化都没有的回合不记账
          // 「显著」决定时间线上标不标小波动（不注入，只是展示口径）
          const sig = Math.abs(delta.moodDelta) >= cfg.moodSigMood
            || DIMS.some(([k]) => Math.abs(delta.dims[k] || 0) >= cfg.moodSigDim)
          if (typeof cfg.applyMoodDelta === 'function') {
            cfg.applyMoodDelta(delta, { minor: !sig })
          }
          if (note) note('mood', `${sig ? '心情更新' : '小波动'}：${delta.reason || '（无理由）'}${mode ? `（${mode === 'talk' ? '自己搭话' : '定时任务'}）` : ''}`)
        })
        .catch((e) => { if (note) note('mood', `判断失败：${e instanceof Error ? e.message : e}`) })
    }))
  } catch (e) {
    if (note) note('mood', `监听 turn-stopping 失败：${e instanceof Error ? e.message : e}`)
  }

  const entry = { offs }
  mounted.set(agent, entry)
  mountedOffs.add(entry)
}


/** 拆掉全部钩子（插件卸载/测试用）。 */
export function unobserveAll() {
  // 遍历 mountedOffs 而不是 mounted：WeakMap 不可枚举
  for (const entry of mountedOffs) {
    for (const off of entry.offs) {
      try { if (typeof off === 'function') off() } catch { /* ignore */ }
    }
  }
  mountedOffs.clear()
}


/** 测试用：当前挂了几个 agent。 */
export const observedCount = () => mountedOffs.size
