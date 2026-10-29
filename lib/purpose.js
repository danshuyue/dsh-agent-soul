/**
 * purpose.js —— 「目的机制」的精简版：让 AI 心里有惦记的事（纯逻辑，零 I/O）。
 *
 * ── 它学的是什么 ──
 * SurfCore 的目的机制不是为了「定时发一句问候」，而是给 AI 一个**会衰减的内在状态**：
 *   · 几个需求维度（好奇 / 在乎 / 想分享 / 想搞懂）各有 0~1 的驱动值；
 *   · 驱动值随时间半衰期衰减回基线，被素材反复刺激又会涨；
 *   · 从记忆里提炼「没闭合的事」作为目标候选；
 *   · 说出去了驱动才真的降（×0.45），没说只轻微回落。
 * 这样她的主动行为有连续性 —— 是「憋了一阵想说」，不是每轮随机抽卡。
 *
 * ── 本地版做了什么简化 ──
 * 原版是为 QQ 群聊写的：有大量素材、要挑时机主动发消息、要防打扰。
 * 本地 DSH 会话里**没有推送渠道**（用户不打开就没有回合），所以：
 *   · 删掉所有排程、静默时段、投递/回执逻辑（那些属于「发消息」，不属于「有目的」）；
 *   · 保留驱动衰减 + 从记忆提炼目标 + 影响语气；
 *   · 注入一段「你心里惦记的事」，让**她自己**决定要不要提 ——
 *     决定权在模型手里，这比硬塞一句「去问候主人」更像自主，也更不容易变成复读。
 *
 * 一句话：本地的「主动」不是主动发消息，是**主动想起**。
 */

export const PURPOSE_VERSION = 1

/**
 * 四个需求维度。
 *
 * 为什么是这四个而不是八个：
 *   维度越多，单个维度的信号越弱，最后所有驱动都停在基线附近、谁也推不动行为。
 *   四个足够覆盖本地场景，也足够让模型读出「这会儿她是什么状态」。
 */
export const NEEDS = Object.freeze(['curiosity', 'care', 'share', 'mastery'])
export const NEED_LABEL = Object.freeze({
  curiosity: '想弄明白',
  care: '在乎树树',
  share: '想分享',
  mastery: '想搞懂'
})

/** 基线驱动：没有刺激时最终回落到这里。 */
export const BASE_DRIVES = Object.freeze({ curiosity: 0.35, care: 0.45, share: 0.3, mastery: 0.4 })

/** 驱动衰减半衰期（小时）：8 小时落一半，符合「过一夜气就消了、过几天就淡了」的直觉。 */
const HALF_LIFE_HOURS = 8

/** 每个维度「什么事会推高它」—— 全是正则，不调模型。 */
const NEED_WORDS = {
  // 注意别把同一个词写两遍：needsFrom 是按「命中几个词」累加的，
  // 重复一次等于给这个维度的权重翻倍（'为什么' 曾经重复过）
  curiosity: ['为什么', '怎么回事', '原理', '是不是', '好奇', '想知', '搞不懂', '奇怪', '疑问', '？', '?'],
  care: ['累', '困', '难受', '不舒服', '压力', '烦', '熬夜', '休息', '注意身体', '吃饭', '睡'],
  share: ['推荐', '安利', '你看', '给你看', '发现', '有意思', '好玩', '试试', '分享'],
  mastery: ['学会', '搞懂', '掌握', '搞定', '写完', '做完', '实现', '踩坑', '修好', '通过', '跑通']
}

/** 目标类型：决定它在提示词里怎么被描述。 */
export const GOAL_KINDS = Object.freeze({
  question: '想弄明白',
  promise: '答应过的',
  curious: '想试试',
  followup: '还没聊完'
})

const clamp = (value, min, max) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return min
  return Math.min(max, Math.max(min, num))
}

const HOUR = 60 * 60 * 1000

/** 一段文本指向哪些维度（0~1/维）。 */
export function needAffinity(text) {
  const body = String(text ?? '').toLowerCase()
  const out = {}
  for (const need of NEEDS) {
    let hits = 0
    for (const word of NEED_WORDS[need]) if (body.includes(word.toLowerCase())) hits += 1
    out[need] = clamp(hits / 2.5, 0, 1)
  }
  return out
}

/**
 * 驱动衰减 + 受刺激上涨。
 *
 * 关键设计：**用「地板」而不是累加**给人格先验设下限。
 * 累加的话每轮都 +bias，几十轮后所有驱动都被顶到 1，等于没有状态。
 */
export function deriveDrives({ drives, drivesAt = 0, materials = [], now = Date.now(), idleHours = 0 } = {}) {
  const next = { ...BASE_DRIVES }
  if (drives !== null && typeof drives === 'object') {
    for (const need of NEEDS) {
      const value = Number(drives[need])
      if (Number.isFinite(value)) next[need] = clamp(value, 0, 1)
    }
  }

  // 1) 时间衰减回基线
  const hours = drivesAt > 0 ? Math.min(24 * 30, Math.max(0, (now - drivesAt) / HOUR)) : 0
  const decay = Math.pow(0.5, hours / HALF_LIFE_HOURS)
  for (const need of NEEDS) next[need] = BASE_DRIVES[need] + (next[need] - BASE_DRIVES[need]) * decay

  // 2) 素材刺激：最近聊到的东西会推高对应维度（一次最多看 12 条，避免越聊越满）
  for (const material of materials.slice(0, 12)) {
    const affinity = material?.affinity ?? needAffinity(`${material?.text ?? ''} ${material?.title ?? ''}`)
    for (const need of NEEDS) next[need] = Math.min(1, next[need] + (affinity[need] ?? 0) * 0.05)
  }

  // 3) 久没说话 → 想分享/在乎会慢慢涨（这就是「憋了一阵」的来源，不是随机出现）
  if (idleHours > 0) {
    const bump = Math.min(0.25, (idleHours / 24) * 0.2)
    next.share = Math.min(1, next.share + bump)
    next.care = Math.min(1, next.care + bump * 0.8)
  }

  return { drives: next, drivesAt: now }
}

/**
 * 由驱动值推一个「此刻的状态」。
 * 只有四种，够模型读懂，也不至于让提示词里出现一堆没用的形容词。
 */
export function moodOf(drives) {
  const d = drives !== null && typeof drives === 'object' ? drives : BASE_DRIVES
  const top = NEEDS.reduce((best, need) => (Number(d[need]) > Number(d[best]) ? need : best), NEEDS[0])
  const value = Number(d[top]) || 0
  if (value < 0.55) return { mood: 'calm', need: top, value, label: '安静' }
  if (top === 'curiosity') return { mood: 'curious', need: top, value, label: '有点好奇' }
  if (top === 'care') return { mood: 'attentive', need: top, value, label: '有点在意你' }
  if (top === 'share') return { mood: 'chatty', need: top, value, label: '有点想说点什么' }
  return { mood: 'eager', need: top, value, label: '有点手痒' }
}

/** 说出去了驱动才真的降（原版的 satisfyDrives，这里只留核心）。 */
export function satisfyDrives(drives, need, outcome = 'sent') {
  const next = { ...BASE_DRIVES, ...(drives ?? {}) }
  if (!NEEDS.includes(need)) return next
  const factor = outcome === 'sent' ? 0.45 : 0.85
  next[need] = clamp(Number(next[need]) * factor, 0, 1)
  return next
}

// ---- 目标：从记忆里提炼「没闭合的事」 ----

const QUESTION_RE = /为什么|怎么回事|是不是|能不能|怎么|如何|在哪|有没有|要不要|行不行|[？?]/
const PROMISE_RE = /答应|约定|说好|下次|以后|明天|后天|周末|回头|记得|别忘了/
const CURIOS_RE = /想试|想玩|想学|想搞|好奇|有机会|要不|试试/

/**
 * 从记忆卡里挖目标候选。
 *
 * 三路来源，都只看「还没闭合」的味道：
 *   · promise 标签 → 答应过但没做完的事
 *   · 疑问句 → 没弄明白的事
 *   · 想试 / 好奇 → 悬着的兴趣
 *
 * 已经是 forgotten 的不算（连她自己都想不起来了，不该惦记）。
 */
export function mineGoals(card, { limit = 8 } = {}) {
  const records = Array.isArray(card?.records) ? card.records : []
  const out = []
  for (const record of records) {
    if (record.clarity === 'forgotten') continue
    const text = String(record.text ?? '').trim()
    if (text.length < 4) continue
    const tags = Array.isArray(record.tags) ? record.tags : []
    let kind = ''
    if (tags.includes('promise') || PROMISE_RE.test(text)) kind = 'promise'
    else if (QUESTION_RE.test(text)) kind = 'question'
    else if (CURIOS_RE.test(text)) kind = 'curious'
    if (kind === '') continue
    // 权重：重要度打底，清晰度加成（越想不起来的越该先弄清），承诺类再加一点
    const clarityBonus = record.clarity === 'vivid' ? 8 : record.clarity === 'clear' ? 5 : 2
    const kindBonus = kind === 'promise' ? 12 : 0
    out.push({
      id: `mem-${record.id}`,
      text: text.slice(0, 80),
      kind,
      weight: (Number(record.importance) || 0) + clarityBonus + kindBonus,
      source: 'memory',
      createdAt: record.createdAt
    })
  }
  out.sort((a, b) => b.weight - a.weight)
  return out.slice(0, clamp(limit, 1, 30))
}

/** 新建一份空的目的状态。 */
export function createState(now = Date.now()) {
  return {
    version: PURPOSE_VERSION,
    drives: { ...BASE_DRIVES },
    drivesAt: now,
    goals: [],
    // 本轮渲染出去、等着看她说没说出口的目标（settleServed 的消费对象）
    served: [],
    updatedAt: new Date(now).toISOString()
  }
}

/** 结构收敛（坏文件不该让插件起不来）。 */
export function normalizeState(raw, now = Date.now()) {
  const state = createState(now)
  if (raw === null || typeof raw !== 'object') return state
  if (raw.drives !== null && typeof raw.drives === 'object') {
    for (const need of NEEDS) {
      const value = Number(raw.drives[need])
      if (Number.isFinite(value)) state.drives[need] = clamp(value, 0, 1)
    }
  }
  state.drivesAt = Number(raw.drivesAt) || now
  state.goals = (Array.isArray(raw.goals) ? raw.goals : [])
    .map((goal) => normalizeGoal(goal))
    .filter((goal) => goal !== null)
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : state.updatedAt
  state.served = (Array.isArray(raw.served) ? raw.served : [])
    .map(normalizeServed)
    .filter((item) => item !== null)
    .slice(-20)
  return state
}

function normalizeServed(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = String(raw.id ?? '').trim()
  if (id === '') return null
  return {
    id,
    text: String(raw.text ?? '').slice(0, 120),
    at: Number(raw.at) || Date.now()
  }
}

function normalizeGoal(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const text = String(raw.text ?? '').trim()
  if (text === '') return null
  return {
    id: String(raw.id ?? `goal-${text.length}-${String(raw.createdAt ?? '')}`),
    text: text.slice(0, 120),
    kind: GOAL_KINDS[raw.kind] !== undefined ? raw.kind : 'curious',
    weight: clamp(Number(raw.weight) || 40, 0, 200),
    source: String(raw.source ?? 'manual'),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    closedAt: typeof raw.closedAt === 'string' ? raw.closedAt : null
  }
}

/** 加一个目标（去重：同样的文字只留一条）。 */
export function addGoal(state, input = {}, now = Date.now()) {
  const text = String(input.text ?? '').trim()
  if (text === '') return { ok: false, reason: '空目标' }
  const key = text.replace(/\s+/g, '')
  const exists = state.goals.find((goal) => goal.closedAt === null && goal.text.replace(/\s+/g, '') === key)
  if (exists !== undefined) return { ok: false, reason: '这个目标已经在惦记着了', goal: exists }
  const goal = normalizeGoal({
    id: `goal-${now}-${state.goals.length}`,
    text,
    kind: input.kind,
    weight: input.weight,
    source: input.source ?? 'manual',
    createdAt: new Date(now).toISOString()
  })
  state.goals.push(goal)
  // 上限 40 条：目标堆太多等于没有目标
  if (state.goals.length > 40) {
    state.goals.sort((a, b) => (b.closedAt === null ? 1 : 0) - (a.closedAt === null ? 1 : 0) || b.weight - a.weight)
    state.goals = state.goals.slice(0, 40)
  }
  state.updatedAt = new Date(now).toISOString()
  return { ok: true, goal }
}

/** 关闭一个目标（做完 / 不想了）。 */
export function closeGoal(state, id, now = Date.now()) {
  const goal = state.goals.find((item) => item.id === id)
  if (goal === undefined) return false
  goal.closedAt = new Date(now).toISOString()
  state.updatedAt = goal.closedAt
  return true
}

/** 还没闭合的目标（按权重排序）。 */
export function openGoals(state, { limit = 6 } = {}) {
  const list = (Array.isArray(state?.goals) ? state.goals : []).filter((goal) => goal.closedAt === null)
  list.sort((a, b) => b.weight - a.weight)
  return list.slice(0, clamp(limit, 1, 20))
}

/**
 * 渲染成注入提示词的一段。
 *
 * ⚠️ 长度是硬约束：这段**每回合都重发**（跟工具 schema 一样是常驻成本）。
 *   按 DSH 的 4 字符/token 粗算，中文真实约 1.4~1.9 倍 —— 300 字大约 300~500 token。
 *   所以：最多 3 条目标、每条一行、不写解释性废话。
 */
export function renderPurpose(state, { now = Date.now(), maxGoals = 3, maxChars = 320 } = {}) {
  const goals = openGoals(state, { limit: maxGoals })
  const mood = moodOf(state?.drives)
  if (goals.length === 0 && mood.mood === 'calm') return ''

  const lines = ['【你心里惦记的事】']
  const hints = [
    '（这些不是任务清单，是你自己一直没放下的事：合适的时候自己提，不需要每轮都提，也不要为了提而提。）'
  ]
  if (mood.mood !== 'calm') hints.push(`（此刻状态：${mood.label}。）`)

  const body = goals.map((goal) => {
    const label = GOAL_KINDS[goal.kind] ?? '想试试'
    return `- （${label}）${goal.text}`
  })

  let out = [...lines, ...hints, ...body].join('\n')
  if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 1))}…`
  return out
}

/** 设置页要看的摘要。 */
export function summarize(state, now = Date.now()) {
  const mood = moodOf(state?.drives)
  return {
    drives: { ...(state?.drives ?? BASE_DRIVES) },
    mood,
    open: openGoals(state, { limit: 20 }).length,
    total: (state?.goals ?? []).length,
    idleHours: state?.drivesAt > 0 ? Math.round(((now - state.drivesAt) / HOUR) * 10) / 10 : 0
  }
}

// --------------------------------------------------------------------------
// 情绪 → 驱动：七情推着她惦记
// --------------------------------------------------------------------------

/**
 * 七情怎么变成「惦记」。
 *
 * 目的机制原来的驱动只靠两件事：素材刺激（聊到什么词）和久没说话。结果四个维度
 * 常年贴在基线上 —— 因为**情绪才是惦记的真正来源**：担心你才会惦记你有没有加衣服，
 * 开心才更想跟你说点什么。这一层不接，目的机制就只是个空转的衰减器。
 *
 * 权重是「这条情绪有多指向这个需求」，0~1。
 */
export const EMOTION_AFFINITY = Object.freeze({
  heartache: { care: 1 },
  worry: { care: 0.9 },
  sad: { care: 0.6 },
  jealous: { care: 0.4, share: 0.2 },
  happy: { share: 0.8, care: 0.2 },
  sweet: { share: 0.6, care: 0.4 },
  // 踏实是「已经满足了」—— 反而没那么急着说什么，轻微往下压
  calm: { share: -0.2 }
})

/** 情绪拉满时，驱动最多能偏离基线多少。留够余量，别让担心 = 驱动直接顶到 1。 */
const EMOTION_SPAN = 0.45

/**
 * 七情「满格」折算成多少分。
 *
 * ⚠️ 不是 100。判定单次上限是 ±10，情绪又被 90 分钟半衰期往下磨 —— 2026-10-29
 * 实测一整天走下来，七情峰值只到 13（开心）/ 12（踏实）。按 100 分制折算的话
 * 13 分只是 0.13，推出来的偏移不到 0.05，这层等于没接。
 * 取 20：连着两轮「明显的好/坏」（各 ±5~10）就算满格，符合「真的动过心」的直觉。
 */
const EMOTION_FULL = 20

/** 由当前七情推出各需求维度的目标值（0~1）。 */
export function emotionTargets(dims = {}) {
  const out = { ...BASE_DRIVES }
  const level = (key) => clamp(Number(dims?.[key]) || 0, 0, EMOTION_FULL) / EMOTION_FULL
  for (const need of NEEDS) {
    let strongest = 0
    for (const [emotion, weights] of Object.entries(EMOTION_AFFINITY)) {
      const weight = Number(weights?.[need])
      if (!Number.isFinite(weight) || weight === 0) continue
      const value = level(emotion) * weight
      // 取最强的一条，不是累加：心疼 + 担心 + 难过同时上来也不该把 care 直接顶满
      if (Math.abs(value) > Math.abs(strongest)) strongest = value
    }
    out[need] = clamp(out[need] + strongest * EMOTION_SPAN, 0, 1)
  }
  return out
}

/**
 * 让驱动向「情绪推出的目标」靠拢一步。
 *
 * 为什么不直接加：情绪是**持续状态**不是脉冲，每轮 +x 会在几十轮后把所有驱动顶到 1，
 * 等于没有状态（deriveDrives 里用「地板」而不是累加，是同一个教训）。
 * 按比例靠拢则天然有收敛点：情绪在，驱动停在较高的地方；情绪衰减回去，
 * 目标也回到基线，驱动跟着落下来。
 */
export function applyEmotionToDrives(drives, dims, { pull = 0.15 } = {}) {
  const base = { ...BASE_DRIVES, ...(drives ?? {}) }
  const target = emotionTargets(dims)
  const step = clamp(Number(pull), 0, 1)
  const out = {}
  for (const need of NEEDS) {
    const cur = clamp(Number(base[need]) || 0, 0, 1)
    out[need] = clamp(cur + (target[need] - cur) * step, 0, 1)
  }
  return out
}

// --------------------------------------------------------------------------
// 「说出去了才算完」：接上 satisfyDrives
// --------------------------------------------------------------------------

const STRIP_RE = /[\s，。！？、；：""''「」『』（）()【】\[\],.!?;:~—…]|_/g

/** 取 n 字滑动词组（用于判断两句话有没有真正说到同一件事）。 */
function grams(text, n) {
  const body = String(text ?? '').replace(STRIP_RE, '')
  const out = []
  for (let i = 0; i + n <= body.length; i += 1) out.push(body.slice(i, i + n))
  return out
}

/**
 * 她回的这句话，有没有真的说到那件惦记的事。
 *
 * 用 3 字词组匹配而不是关键词表：目标文本是自由文本，列不出词表；而 2 字太容易
 * 撞上「今天」「是不是」这类通用词。文本太短（不到 3 字）就退到 2 字，宁可宽松一点。
 */
export function sharesPhrase(goalText, reply, n = 3) {
  const body = String(reply ?? '')
  if (body.trim() === '') return false
  const size = String(goalText ?? '').replace(STRIP_RE, '').length >= n ? n : 2
  const pieces = grams(goalText, size)
  if (pieces.length === 0) return false
  const flat = body.replace(STRIP_RE, '')
  return pieces.some((piece) => flat.includes(piece))
}

/** 这句话主要指向哪个需求（说出口了，哪个需求才算被满足）。 */
export function dominantNeed(text, drives = {}) {
  const affinity = needAffinity(text)
  let best = NEEDS[0]
  for (const need of NEEDS) {
    const score = Number(affinity[need]) || 0
    const bestScore = Number(affinity[best]) || 0
    if (score > bestScore || (score === bestScore && Number(drives[need]) > Number(drives[best]))) best = need
  }
  return best
}

/** 记下本轮渲染出去的目标 —— 下一轮才有得可查。 */
export function markServed(state, goals, now = Date.now()) {
  if (state === null || typeof state !== 'object') return false
  const list = Array.isArray(state.served) ? state.served : []
  let changed = false
  for (const goal of Array.isArray(goals) ? goals : []) {
    const id = String(goal?.id ?? '')
    if (id === '' || list.some((item) => String(item?.id ?? '') === id)) continue
    list.push({ id, text: String(goal?.text ?? '').slice(0, 120), at: now })
    changed = true
  }
  // 上限 20 条：目标一共才 40 条上限，served 不该比它更能堆
  if (list.length > 20) list.splice(0, list.length - 20)
  if (changed) state.served = list
  return changed
}

/**
 * 消化：上一轮渲染出去的目标，她有没有说出口。
 *
 * ── 规则 ──
 *   · 不到 minAgeMs 的跳过：刚渲染完还没轮到她说话，这时候判定必然是「没说」
 *   · 她的话里说到了 → sent（×0.45，真放下）
 *   · 一直没说到，超过 giveUpMs → skipped（×0.85，慢慢淡了）
 *   · 两条都只判一次：判完就移出列表 —— 否则每轮都 ×0.85，驱动会被反复压到 0，
 *     跟情绪牵引打架
 *
 * 这是 satisfyDrives 唯一的调用点：那块代码从写下来就没接过（2026-10-30 之前是死代码）。
 */
export function settleServed(state, { assistantText = '', now = Date.now(), minAgeMs = 60000, giveUpMs = 6 * 3600000 } = {}) {
  const empty = { sent: [], skipped: [] }
  if (state === null || typeof state !== 'object') return empty
  const list = Array.isArray(state.served) ? state.served : []
  if (list.length === 0) return empty

  const reply = String(assistantText ?? '')
  const kept = []
  const sent = []
  const skipped = []
  for (const item of list) {
    const id = String(item?.id ?? '')
    const age = now - (Number(item?.at) || 0)
    if (id === '' || age < minAgeMs) {
      if (id !== '') kept.push(item)
      continue
    }
    const need = dominantNeed(item?.text ?? '', state.drives)
    if (sharesPhrase(item?.text ?? '', reply)) {
      state.drives = satisfyDrives(state.drives, need, 'sent')
      sent.push(id)
      continue
    }
    if (age < giveUpMs) {
      kept.push(item)
      continue
    }
    state.drives = satisfyDrives(state.drives, need, 'skipped')
    skipped.push(id)
  }
  state.served = kept
  state.updatedAt = new Date(now).toISOString()
  return { sent, skipped }
}
