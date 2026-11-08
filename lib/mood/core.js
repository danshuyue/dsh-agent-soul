/**
 * 心情引擎 · core.js
 * 由 lib/mood.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */



// --------------------------------------------------------------------------
// 常量
// --------------------------------------------------------------------------

/** 心情是「基调」，每轮只吃判定值的 1/3 —— 几轮对话才累积挪一格（七情才即时动）。 */
export const MOOD_STEP_DIVISOR = 3


/** 七情（顺序固定，界面按这个排）。 */
export const DIMS = Object.freeze([
  ['happy', '开心'],
  ['calm', '踏实'],
  ['sweet', '甜蜜'],
  ['heartache', '心疼'],
  ['worry', '担心'],
  ['sad', '难过'],
  ['jealous', '吃醋'],
])


/** 时间线留多少条（老的挤掉，防止 state 文件无限膨胀）。 */
export const TIMELINE_CAP = 200


/**
 * 七情的「满格」= 20，不是 100。
 *
 * ⚠️ 判定单次上限 ±10，情绪又被 90 分钟半衰期往回磨 —— 2026-10-29 实测一整天
 * 走下来，峰值只到 13（开心）/ 12.8（踏实）。按 100 分制显示的话，「开心 13」
 * 看起来像「才 13%」，其实那是相当高兴了。
 * 取 20：连着两轮明显的好/坏（各 ±5~10）就算满格。
 * 所有对外显示七情的地方（设置页、日记）都按这个折算成百分比。
 */
export const DIM_FULL = 20


/** 七情原始值 → 百分比（0~100，按 20 满格）。 */
export const dimPercent = (v) => {
  const raw = Number(v)
  if (!Number.isFinite(raw)) return 0
  return Math.round((Math.min(Math.max(raw, 0), DIM_FULL) / DIM_FULL) * 100)
}


/** 百分比 → 一个能读出来的词（比数字更像「她现在怎么样」）。 */
export const dimWord = (percent) => {
  const p = Number(percent) || 0
  if (p <= 0) return '没有'
  if (p < 25) return '一点点'
  if (p < 50) return '有点'
  if (p < 75) return '挺'
  return '很'
}


/** 这个百分比算不算「最突出」（topDims 的门槛，按百分比而不是原始值）。 */
const DIM_TOP_PERCENT = 25


const MIN = 60000


/** 情绪向 0 衰减的半衰期（分钟）—— 单根情绪比总心情散得快。 */
const DIM_HALF_LIFE_MIN = 90


/** 自然平复记账的阈值：距上次记过的那条走了 3 格以上才算。 */
const DECAY_NOTE_STEP = 3


// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))


/** 转义正则元字符：symbol 化的词表是动态拼进 new RegExp 的，
 *  万一将来有人往 VERBS 里加 `*`/`.`/`?` 等会静默改判 —— 先逃掉就不踩这个坑。 */
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')


/** 七情取整（状态里存小数，只有对外显示取整）。 */
export const displayDims = (s) => Object.fromEntries(DIMS.map(([k]) => [k, Math.round(s.dims[k] || 0)]))


/**
 * 七情的显示值：百分比（按 DIM_FULL=20 满格）。
 *
 * 原始值只留给内部算（驱动、日记的原始快照），**对外一律用这个** ——
 * 「踏实 12.8」在界面上读起来像「才 12%」，实际那是很踏实了。
 */
export const displayDimPercents = (s) => Object.fromEntries(DIMS.map(([k]) => [k, dimPercent(s?.dims?.[k])]))


export function moodLabel(v) {
  const n = Math.round(Number(v) || 0)
  if (n >= 80) return '欢喜'
  if (n >= 62) return '开心'
  if (n >= 42) return '一般'
  if (n >= 25) return '心疼'
  return '难过'
}


/**
 * 五档表情对应哪张图（assets/face-<名字>.png）。
 * 版权：五张图与阈值来自 dsh-feiyu-mood（原作者 Yuuyuko-uu，
 * 《Yuuyuko-uu 插件许可 1.2》），见 assets/README.md 与 THIRD-PARTY-NOTICES.md §3.1。
 * 图是跟着心情走的同一套（原 dsh-feiyu-mood 那五张），阈值也跟它一致：
 * 80 以上欢喜、62 以上开心、42 以上一般、25 以上心疼，再低就是难过。
 * 返回文件名里的那段名字，Web 端拼成图地址 —— 这里不掺 URL，lib 层只算账。
 */
export function moodFace(v) {
  const n = Number(v)
  // 认不出数值时按中间那档走（原 dsh-feiyu-mood 也是这么兜的），别让页面开天窗
  if (!Number.isFinite(n)) return 'ok'
  if (n >= 80) return 'great'
  if (n >= 62) return 'good'
  if (n >= 42) return 'ok'
  if (n >= 25) return 'worry'
  return 'sad'
}


/** 最高的几根七情（≥15 才算数）。 */
export function topDims(s, n = 2) {
  return DIMS
    .map(([k, label]) => {
      const v = Number(s?.dims?.[k]) || 0
      const p = dimPercent(v)
      return { k, label, v, p, word: dimWord(p) }
    })
    // 门槛按百分比：原来写死 `v >= 15`（100 分制的 15）—— 实测峰值才 12.8，
    // 这个条件永远不成立，设置页「最突出」一直是空的。
    .filter((x) => x.p >= DIM_TOP_PERCENT)
    .sort((a, b) => b.p - a.p)
    .slice(0, n)
}


// --------------------------------------------------------------------------
// 状态形状（纯逻辑，存盘在 store.js）
// --------------------------------------------------------------------------

export function blankMoodState(base = 70) {
  return {
    mood: clamp(Number(base) || 70, 0, 100),
    dims: Object.fromEntries(DIMS.map(([k]) => [k, 0])),
    lastReason: '',
    lastConfidence: 0,
    lastNotedMood: clamp(Number(base) || 70, 0, 100),
    minor: false,
    kind: '', // '' = 判断出来的变化 / 'decay' = 自己平复的
    updatedAt: Date.now(),
    lastDecayAt: Date.now(),
    timeline: [],
  }
}


/**
 * 把判定理由里的代词收一收。
 * ⚠ 只在够确定的时候才把「她/他」换成称呼（一个句子里代词只出现一次、
 *   且紧跟说话动词、且没有别人当主语）—— 有第三者就原样保留，
 *   少一次美化，好过把第三人称认错（2026-10-25 真踩过）。
 */
export function normReason(s, owner = '') {
  const name = String(owner || '').trim()
  const raw = String(s || '')
  if (!name || !raw) return raw
  const speechVerbs = '说|问|讲|答|喊|回|笑|想|觉得|解释|抱怨|嘟囔|念叨'
    .split('|').map(escapeRegExp).join('|')
  const sentences = raw.split(/(?<=[。！？!?；;])/)
  return sentences.map((sent) => {
    const pronounCount = (sent.match(/[她他]/g) || []).length
    if (pronounCount !== 1) return sent
    const hasThird = /(^|[^她他])([一-龥]{2,4})(说|问|讲|答|喊|回|笑)/.test(sent.replace(/[她他]/g, ''))
    if (hasThird) return sent
    return sent.replace(new RegExp('([她他])(?=(' + speechVerbs + '))', 'g'), name)
  }).join('')
}


/** 宽容解析模型输出的 JSON（容忍 markdown 包裹 / 前后杂字）。 */
export function parseDelta(text, owner = '') {
  const raw = String(text || '').trim()
  if (!raw) return null
  let obj = null
  const a = raw.indexOf('{')
  const b = raw.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try { obj = JSON.parse(raw.slice(a, b + 1)) } catch { /* 再试整体 */ }
  }
  if (!obj) {
    try { obj = JSON.parse(raw) } catch { return null }
  }
  if (!obj || typeof obj !== 'object') return null
  const delta = {
    moodDelta: clamp(Math.round(Number(obj.moodDelta) || 0), -10, 10),
    dims: Object.fromEntries(DIMS.map(([k]) => [k, 0])),
    reason: normReason(obj.reason, owner).slice(0, 120),
    confidence: Number.isFinite(Number(obj.confidence))
      ? clamp(Math.round(Number(obj.confidence)), 0, 100)
      : 70,
  }
  if (obj.dims && typeof obj.dims === 'object') {
    for (const [k] of DIMS) delta.dims[k] = clamp(Math.round(Number(obj.dims[k]) || 0), -10, 10)
  }
  return delta
}


/**
 * 判定分数 → 心情实际步长（2026-11-06 审计 P0-2）。
 *
 * 原来是 `Math.round(delta / 3)`，而 `round(±1/3) === 0`：
 * 判定模型按 prompt 的要求给出 -1（「日常的累/困/没吃好」正好落在 -1~-4），
 * 心情数值**一动都不动**；+1 同理。更糟的是 timeline 仍然记一条 delta:0，
 * 日志看上去一切正常。
 *
 * 现在的口径：非零就给至少 ±1，|delta| ≥ 4 之后才按三分法放大。
 *   ±1..±4 → ±1     ±5..±7 → ±2     ±8..±10 → ±3
 * 这样「一点点变化」能累积成可见的变化，同时大波动不会被放大成跳变。
 */
export function moodStepOf(moodDelta) {
  const raw = Number(moodDelta) || 0
  if (raw === 0) return 0
  const steps = Math.round(Math.abs(raw) / MOOD_STEP_DIVISOR)
  return Math.sign(raw) * Math.max(1, steps)
}


/** 应用一次判定：心情慢动、七情即时、记时间线。 */
export function applyDelta(s, delta, { floor = 0, minor = false } = {}) {
  const moodStep = moodStepOf(delta.moodDelta)
  s.mood = clamp(s.mood + moodStep, floor, 100)
  // 七情的满格是 DIM_FULL（=20），不是 100（2026-11-01 审计 D13a）。
  // 旧代码 clamp 到 0~100，超过 20 之后 displayDims 的百分比恒为 100%，
  // 分辨率全丢：14 和 60 看起来一样"满"。purpose.js 早就是按 DIM_FULL 收的，这里是异类。
  for (const [k] of DIMS) s.dims[k] = clamp((s.dims[k] || 0) + (delta.dims[k] || 0), 0, DIM_FULL)
  s.lastReason = delta.reason
  s.lastConfidence = delta.confidence
  s.minor = Boolean(minor)
  s.kind = ''
  s.lastNotedMood = s.mood
  s.updatedAt = Date.now()
  s.lastDecayAt = Date.now() // 刚变过，衰减计时归零
  s.timeline.push({
    at: Date.now(),
    mood: Math.round(s.mood),
    delta: moodStep,
    reason: delta.reason,
    conf: delta.confidence,
    minor: Boolean(minor),
    dims: displayDims(s),
    dimsDelta: { ...delta.dims },
  })
  if (s.timeline.length > TIMELINE_CAP) s.timeline.splice(0, s.timeline.length - TIMELINE_CAP)
  return s
}


/** 自然平复也算一次「变化」—— 隔夜悄悄回稳也要留痕，不然时间对不上、显得记仇。 */
function noteDecay(s, base) {
  const driftingDown = s.mood < s.lastNotedMood
  s.lastReason = driftingDown
    ? '过了几个钟头，刚才那点劲儿慢慢淡了，心里回到平常的样子'
    : '过了几个钟头，心里那点别扭自己散了，人也松快回来'
  s.lastConfidence = 100 // 本地算的，不是模型猜的
  s.updatedAt = Date.now()
  s.lastNotedMood = s.mood
  s.minor = false
  s.kind = 'decay'
  s.timeline.push({
    at: Date.now(), mood: Math.round(s.mood), delta: 0, conf: 100, kind: 'decay',
    reason: s.lastReason, dims: displayDims(s), dimsDelta: {},
  })
  if (s.timeline.length > TIMELINE_CAP) s.timeline.splice(0, s.timeline.length - TIMELINE_CAP)
}


/**
 * 时间衰减：心情向 base 回落（半衰期 decayHalfHours 小时）、七情向 0 衰减（90 分钟）。
 * 跟「上次记过的那条」比走了 3 格以上才记一条平复 —— 不能跟上一次调用比，
 * 面板轮询每 20 秒一次、单次只挪 0.x 格，永远攒不够。
 */
export function decayMood(s, base, now = Date.now(), halfHours = 12) {
  const ageMin = Math.max(0, now - (s.lastDecayAt || now)) / MIN
  if (ageMin < 1) return s // 不足 1 分钟不算衰减
  const halfMood = clamp(Number(halfHours) || 12, 1, 168) * 60
  const km = 1 - Math.exp(-(Math.LN2 * ageMin) / halfMood)
  s.mood = s.mood + (base - s.mood) * km
  const ke = 1 - Math.exp(-(Math.LN2 * ageMin) / DIM_HALF_LIFE_MIN)
  for (const [k] of DIMS) s.dims[k] = Math.max(0, (s.dims[k] || 0) * (1 - ke))
  s.lastDecayAt = now
  if (Math.abs(s.mood - s.lastNotedMood) >= DECAY_NOTE_STEP) noteDecay(s, base)
  return s
}


/** 规整读进来的状态（容错：坏字段回默认，timeline 截断）。 */
export function normMoodState(raw, base = 70) {
  const d = blankMoodState(base)
  if (raw && typeof raw === 'object') {
    const mood = raw.mood == null ? base : Number(raw.mood)
    d.mood = clamp(Number.isFinite(mood) ? mood : base, 0, 100)
    d.lastReason = normReason(raw.lastReason).slice(0, 200)
    d.lastConfidence = clamp(Math.round(Number(raw.lastConfidence) || 0), 0, 100)
    d.lastNotedMood = Number.isFinite(Number(raw.lastNotedMood))
      ? clamp(Number(raw.lastNotedMood), 0, 100)
      : d.mood
    d.minor = raw.minor === true
    d.kind = String(raw.kind || '')
    d.updatedAt = Number(raw.updatedAt) || Date.now()
    d.lastDecayAt = Number(raw.lastDecayAt) || d.updatedAt
    if (raw.dims && typeof raw.dims === 'object') {
      // 2026-11-06 审计 P0-3：读盘也按 DIM_FULL 收。
      // 原来写盘 clamp 0~20、读盘 clamp 0~100，盘上留一个 50（旧版本写的 / 手改的）时：
      //   displayDims 当 50/20 → 恒 100%、tone 当 50/20>=0.7 → 永远 strong、
      //   purpose 又 clamp 回 20 —— 同一个值三处三种结论。
      // 现在读写同一个满格，脏值一律压到满格（等价于按比例迁移到 100%）。
      // 迁移的痕迹由 IO 层（state/mood-state.js）负责记日志 —— 本文件是纯函数区，不碰 note()。
      for (const [k] of DIMS) {
        d.dims[k] = clamp(Number(raw.dims[k]) || 0, 0, DIM_FULL)
      }
    }
    d.timeline = Array.isArray(raw.timeline)
      ? raw.timeline.slice(-TIMELINE_CAP).map((t) => ({ ...t, reason: normReason(t.reason) }))
      : []
  }
  return d
}


/** 配置里跟心情有关的字段：读进来时收紧到合法区间。 */
export function normalizeMoodConfig(raw = {}) {
  const num = (v, lo, hi, dft) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) ? clamp(n, lo, hi) : dft
  }
  const str = (v, max = 24) => String(v == null ? '' : v).trim().slice(0, max)
  return {
    moodEnabled: raw.moodEnabled !== false,
    moodBase: num(raw.moodBase, 30, 100, 70),
    moodFloor: num(raw.moodFloor, 0, 100, 0),
    moodDecayHalfHours: num(raw.moodDecayHalfHours, 1, 168, 12),
    moodSigMood: num(raw.moodSigMood, 1, 30, 3),
    moodSigDim: num(raw.moodSigDim, 1, 100, 5),
    moodSelfName: str(raw.moodSelfName, 16),
    // 2026-11-04：主人名字的主键统一成 ownerName（见 memory.js 的 DEFAULTS）。
    // moodOwnerName 是旧键，仍然读它只为兼容直接传旧配置的调用方；
    // 两个都没有时是空串，提示词里依赖它的整句会省略（见 buildJudgeSystem）。
    ownerName: str(raw.ownerName || raw.moodOwnerName, 16),
    ownerGender: raw.ownerGender === 'male' || raw.ownerGender === 'female' ? raw.ownerGender : '',
    relationship: str(raw.relationship, 16),
    moodOwnerName: str(raw.ownerName || raw.moodOwnerName, 16),
    moodSelfAliases: str(raw.moodSelfAliases, 60),
    moodJudgeProvider: str(raw.moodJudgeProvider, 60),
    moodJudgeModel: str(raw.moodJudgeModel, 80),
    // 心情语气（2026-11-01）
    moodToneInject: raw.moodToneInject !== false,
    moodToneEveryTurns: num(raw.moodToneEveryTurns, 1, 50, 7),
    moodToneThreshold: num(raw.moodToneThreshold, 3, 40, 8),
  }
}
