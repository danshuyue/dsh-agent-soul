/**
 * tone.js —— 心情影响语气（2026-11-01）
 *
 * 它只做一件事：**隔几轮，往当前这句用户消息后面挂一行心情**。
 *
 * ── 为什么挂在用户消息上，而不是系统提示末尾 ──
 *
 * 一开始想的是在 system prompt 末尾加一句「今天不太有劲」。那个方案有两个毛病：
 *
 *   ① 缓存。系统提示一变，长缓存全失效。心情每轮都在动，等于每轮重建。
 *   ② 更根本的：那是**当下的状态**，说出口就开始过时。三小时后回头看还写着
 *      「今天不太有劲」，已经不对了。
 *
 * 树树给的改法把这个想通了：心情不是「现在的状态」，是**那一刻的状态**，
 * 应该像照片上的日期一样跟着那条消息冻结。挂在消息上之后：
 *   · 系统提示一个字不动，缓存照吃
 *   · 三小时后回头看，那条消息记的是「当时」，永远是对的
 *
 * 代价是长会话里越往后心情越旧 —— 所以**当前这一轮永远用当轮的**，
 * 历史消息照旧冻结。
 *
 * ── 三档 + 每 N 轮 ──
 *
 * 中档（大多数时候）什么都不加。低/高才发，而且每 N 轮才发一次。
 * 真正的约束不是「省 token」，是**给长会话一个硬上限**：
 * 注入条数 ≤ 轮数 / N，永远不会攒出几百条。
 *
 * 计数器按「发出去几条」算，不按「第几轮」算 —— 按轮次算的话，
 * 中间换档会错位，两条之间可能只隔 1 轮。
 */
import { DIM_FULL } from './mood.js'

/** 默认隔 7 轮发一次。 */
export const TONE_DEFAULT_EVERY = 7

/** 三档。中档返回空串 —— 大多数轮次都走这条，这是对的。 */
export const TONE_LEVELS = Object.freeze({
  low: '今天不太有劲，说话会短一些，不太想解释。',
  mid: '',
  high: '今天心情不错，愿意多说两句。'
})

/** 每档轮换几个变体，避免同一句话反复出现显得在演。 */
const VARIANTS = {
  low: [
    '今天不太有劲，说话会短一些，不太想解释。',
    '今天有点提不起精神，话会少一点。',
    '今天心里沉一些，不太想说太多。'
  ],
  high: [
    '今天心情不错，愿意多说两句。',
    '今天状态挺好，话会多一点。',
    '今天心里松快，愿意多聊几句。'
  ]
}

/** 隔离说明：每次都必须跟着，否则「今天的力气」会被当成「这个人变了」。 */
const ISOLATION = '（这只是当时的状态，不是这个人变了。）'

/**
 * 算档位。纯函数，不调模型 —— 模型生成会自我强化，越说越像。
 *
 * @param {object} state moodState() 的返回（含 mood / dims）
 * @param {object} cfg   至少要有 moodBase / moodToneThreshold
 * @returns {'low'|'mid'|'high'}
 */
export function toneLevelOf(state, cfg = {}) {
  const mood = Number(state?.mood)
  if (!Number.isFinite(mood)) return 'mid'
  const base = Number.isFinite(Number(cfg.moodBase)) ? Number(cfg.moodBase) : 70
  const threshold = Math.max(1, Number(cfg.moodToneThreshold) || 8)
  const delta = mood - base

  // 七情里最大的一根（0~1）。它决定「强烈」：心疼爆表时即使心情数字还没跌下去，也该少说话。
  const dims = state?.dims ?? {}
  let top = 0
  for (const value of Object.values(dims)) {
    const n = Number(value) || 0
    if (n > top) top = n
  }
  const strong = top / DIM_FULL >= 0.7

  if (delta <= -threshold) return 'low'
  if (delta >= threshold) return 'high'
  // 心情数字还在中段，但某一根情绪已经很满了 —— 也算有话说
  if (strong) {
    const heavy = Number(dims.sad || 0) + Number(dims.heartache || 0) + Number(dims.worry || 0)
    const light = Number(dims.happy || 0) + Number(dims.sweet || 0) + Number(dims.calm || 0)
    if (heavy > light) return 'low'
    if (light > heavy) return 'high'
  }
  return 'mid'
}

/**
 * 渲染那一行。**不带任何数字** —— 正文里出现「踏实 16.04」这种东西会被模型当真去念。
 */
export function renderTone(level, seed = 0) {
  if (level !== 'low' && level !== 'high') return ''
  const pool = VARIANTS[level]
  const text = pool[Math.abs(Math.trunc(seed)) % pool.length]
  return `［心情：${text}${ISOLATION}］`
}

/**
 * 每会话的计数器（模块级，靠 __resetToneForTest 清）。
 *
 * 语义：pending = 「距离上次发出去，已经过了几轮」。
 * 发出去一条就归零；中档也归零（不发就不该攒着，否则从高档落到中档再升回高档会立刻补一条）。
 */
const counters = new Map()
const COUNTER_MAX = 500

/**
 * 这一轮到底发不发。会**修改**计数器 —— 每轮只能调一次。
 *
 * @param {string} sessionId
 * @param {'low'|'mid'|'high'} level
 * @param {object} cfg     moodToneInject / moodToneEveryTurns
 * @returns {{ emit: boolean, text: string }}
 */
export function takeTone(sessionId, level, cfg = {}) {
  if (cfg.moodToneInject === false) return { emit: false, text: '' }
  const id = String(sessionId ?? '')
  if (id === '') return { emit: false, text: '' }
  if (counters.size > COUNTER_MAX) counters.clear()

  const stay = counters.get(id)
  const pending = stay === undefined ? 0 : stay.pending
  const seed = stay === undefined ? 0 : stay.seed

  // 中档：不发，而且把待发清零
  if (level !== 'low' && level !== 'high') {
    counters.set(id, { pending: 0, seed })
    return { emit: false, text: '' }
  }

  const every = Math.max(1, Math.min(50, Math.trunc(Number(cfg.moodToneEveryTurns) || TONE_DEFAULT_EVERY)))
  // 待发计数到 every 就发一条。归零之后数满 every 轮再发下一条 ——
  // 所以两条之间至少隔 every 轮，换档也不会缩短间隔（换档不动计数器）。
  if (pending < every) {
    counters.set(id, { pending: pending + 1, seed })
    return { emit: false, text: '' }
  }

  // 到了：发一条，计数器归零，seed 往前走（换一个说法）
  counters.set(id, { pending: 0, seed: seed + 1 })
  return { emit: true, text: renderTone(level, seed) }
}

/** 测试用：清计数器。 */
export function __resetToneForTest() {
  counters.clear()
}

/** 测试用：看当前计数（不修改）。 */
export function __toneStateForTest(sessionId) {
  const hit = counters.get(String(sessionId ?? ''))
  return hit === undefined ? null : { ...hit }
}
