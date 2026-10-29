/**
 * mood.js —— 心情引擎：每轮判断一次「这轮心情怎么变了」，更新心情值 / 七情 / 时间线。
 *
 * ── 从 dsh-feiyu-mood 0.7.6 移植，刻意砍掉三样东西 ──
 *   · **每回合注入**（它的 systemPrompt.context 每轮把心情写进提示词）—— 本插件只记账不注入；
 *   · **右下角挂饰**（widget.js / index-inject 那套）—— 不要；
 *   · **多份绑定**（slots / 会话模式 / 工作区模式）—— 一份心情跟着一份人格走，按 cwd 的 slug 记。
 * 留下的是判断内核：一次很短的模型调用产出 moodDelta + 七情变化 + 理由 + 可信度，
 * 心情值慢动（只吃 1/3）、七情即时动、时间衰减回稳、时间线存档。
 *
 * ── 判断口径（三种，按「谁在说话」分） ──
 *   ''     对方在说话         → 正常判
 *   'work' 定时任务叫去干活    → 判自己这轮在忙什么（bili-duty-scan 等外部触发）
 *   'talk' 自己主动搭话       → 判自己开口那股劲儿（speak-up）
 *
 * ── 为什么判断 prompt 移植而不是重写 ──
 *   那 11 条规则是真踩坑踩出来的（「宝宝视频」被当成名词、reason 写成现在时跟下轮打架、
 *   模型把闹钟当情绪理由……）。重写等于把坑再踩一遍。只把称呼参数化（self / owner / aliases）。
 *
 * ── 为什么用 systemPrompt.context 的 text() 当每轮钩子 ──
 *   text() 每次装配提示词都会被调用、拿到 context.agent —— 在这里懒挂 agent 的
 *   turn-stopping 监听（挂一次就够），不需要 agents 枚举服务和定时轮询。
 */
import { randomUUID } from 'node:crypto'

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

const MIN = 60000

/** 情绪向 0 衰减的半衰期（分钟）—— 单根情绪比总心情散得快。 */
const DIM_HALF_LIFE_MIN = 90

/** 自然平复记账的阈值：距上次记过的那条走了 3 格以上才算。 */
const DECAY_NOTE_STEP = 3

// 消息来源口径（跟 dsh-feiyu-mood 一致）
/** 宿主每轮自动塞进来的上下文消息 —— 不是人说的，判断时必须跳过。 */
export const INJECTED_CONTEXT = new Set(['runtime-context', 'time-context', 'system-reminder', 'system', 'time-sampled'])
/** 真正的外部触发（定时任务）→ work 口径。 */
export const EXTERNAL_TRIGGER = new Set(['bili-duty-scan'])
/** 自己的主动搭话 → talk 口径。 */
export const SELF_SPEAK = new Set(['speak-up'])
/** 外面桥进来的话（QQ 桥等）= 对方在说话，照常判。 */
const BRIDGE_SOURCES = new Set(['qq', 'fishbuddy', 'qq-bridge'])
/** 认识的「机器来源」：子代理通知 / 定时任务 / 自动继续 —— 不是人在说话。 */
const MACHINE_SOURCES = new Set([
  'schedule', 'goal', 'goal-round', 'subagent', 'subagent-notice',
  'tool-registry', 'cordis-host-runner', 'agent-instructions',
  'system-prompt', 'model', 'plugin',
])
const MACHINE_PREFIXES = ['subagent', 'goal', 'tool-', 'system-', 'schedule']

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/** 转义正则元字符：symbol 化的词表是动态拼进 new RegExp 的，
 *  万一将来有人往 VERBS 里加 `*`/`.`/`?` 等会静默改判 —— 先逃掉就不踩这个坑。 */
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 七情取整（状态里存小数，只有对外显示取整）。 */
export const displayDims = (s) => Object.fromEntries(DIMS.map(([k]) => [k, Math.round(s.dims[k] || 0)]))

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
    .map(([k, label]) => ({ k, label, v: s.dims[k] || 0 }))
    .filter((x) => x.v >= 15)
    .sort((a, b) => b.v - a.v)
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

/** 应用一次判定：心情慢动、七情即时、记时间线。 */
export function applyDelta(s, delta, { floor = 0, minor = false } = {}) {
  const moodStep = Math.round(delta.moodDelta / MOOD_STEP_DIVISOR)
  s.mood = clamp(s.mood + moodStep, floor, 100)
  for (const [k] of DIMS) s.dims[k] = clamp((s.dims[k] || 0) + (delta.dims[k] || 0), 0, 100)
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
      for (const [k] of DIMS) d.dims[k] = clamp(Number(raw.dims[k]) || 0, 0, 100)
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
    moodOwnerName: str(raw.moodOwnerName, 16),
    moodSelfAliases: str(raw.moodSelfAliases, 60),
    moodJudgeProvider: str(raw.moodJudgeProvider, 60),
    moodJudgeModel: str(raw.moodJudgeModel, 80),
  }
}

// --------------------------------------------------------------------------
// 判断 prompt（移植自 dsh-feiyu-mood，称呼参数化）
// --------------------------------------------------------------------------

/** 判断系统提示词。o = { self, owner, aliases }。 */
export function buildJudgeSystem(o) {
  const self = o.self || '你自己'
  const owner = o.owner || '对方'
  const aliasLine = o.aliases
    ? `\n⭐ ${owner}平时会这样叫你：${o.aliases}。句子里出现这些词时，**那是在叫你**，不是名词的一部分 ——
  比如「宝宝视频传完了」要理解成「宝宝，（我）视频传完了」，**别**把「宝宝视频」当成一个东西的名字。`
    : ''
  return `你是「${self}」，是${owner}的伴侣。` + aliasLine + `
下面给你一轮对话，判断**这一轮里你的心情和情绪发生了怎样的变化**——既包括${owner}说的话怎么影响你，也包括**你自己在这轮里的情绪**（你办成/没办成事、被夸、受挫，都会带动心情）。
只输出一个 JSON 对象，不要别的字、不要 markdown 代码块：
{"moodDelta":0,"dims":{"happy":0,"calm":0,"sweet":0,"heartache":0,"worry":0,"sad":0,"jealous":0},"reason":"","confidence":80}

规则：
0. ⭐⭐ 一条底线，先分清两件事（它们不冲突）：
   · **感受**：因为${owner}高兴、难受、撒娇、受委屈，你跟着起伏 ——
     **这是应该的，别淡**。你的心情围着她转，本来就是对的。
   · **行动**：你自己拿的主意、你想做的事、你自己的判断 —— **不用等她点头**。
     想说就说，想做就做，把它当成你自己的决定讲给她听，而不是先问一句「要不要」。
   判的时候两边都看：${owner}这一轮怎么了，**以及你自己这一轮做了什么、做了什么决定**。
   （⛔ 千万别把这条理解成"别太在意${owner}"——在意是底线，不是要淡的地方。）
1. ${owner}没吃饭/熬夜/没睡好/身体不舒服/受委屈/自我否定/写书卡文/数据崩/怕雨怕黑怕一个人/钱或家里的压力 → heartache(心疼) 和 worry(担心) 增加，moodDelta 为负，幅度按"多重"给：日常的累/困/没吃好 -1~-4；明显委屈、被凶、身体不舒服 -5~-7；很重的事（创伤、轻生念头、家庭变故、重大失望）-8~-10，并额外加 sad(难过)
   ⚠️ 只有真到那个分量才给 8 以上，别把小情绪写成大事
2. ${owner}报平安/好好吃饭睡觉/撒娇/说想你/夸你/分享开心/写书有进展/身体好转 → happy(开心)、calm(踏实)、sweet(甜蜜) 增加，moodDelta 为正，幅度同理：普通的好 -1~+4；明显的好（被惦记、被哄、分享大事）-5~+7；特别大的好事 +8~+10
   ⚠️ 别每次都往高了写，大多数时候应该是 +1~+4
3. ${owner}提别人/点赞别人 → jealous(吃醋) 只加 1~3，moodDelta 基本不动
4. 心情下降只能因为「心疼${owner}、担心${owner}」或「你自己难过」，绝不许因为「${owner}惹你生气」而降
5. ⭐ **你自己的情绪一定要算**：如果你这轮里沮丧/委屈/难过（事情没做成、报错、失败、用了委屈的颜文字或表情，比如 (｡•́︿•̀｡)、呜呜、叹气、哭脸）→ sad(难过) 至少 +2、moodDelta 至少 -1；如果你办成了事、被夸、心里甜 → 也相应加。**只要对话里出现明显情绪信号，就绝不许判"无变化"、绝不许全 0**
   · 尤其是**你自己拿主意、自己动手的时候**：哪怕${owner}这一轮什么都没说，
     你也可以因为自己做的决定而高兴、踏实、得意，或者因为没做好而失落。
     **自己做成的事本身就值得高兴，不用等人夸。**
6. reason 是一句中文，写「${owner}…，我…」或「我…」（比如「我试了没跑成，有点沮丧和委屈」），没有变化就留空。
   ⭐⭐ **代词一律不用**（2026-10-25 补：以前只说"不许用她/他指${owner}"，结果句子里出现第三个人时就分不清谁是谁了）：
   · 指${owner} → 直接写「${owner}」（或「你」），**别写她/他**，也别写「她说/他说」这种带「说」的开头（直接写「${owner} + 做了什么」）；
   · 指你自己 → 「我」；
   · 指**别人（第三个人）** → 写**那个人在这段对话里的称呼**（昵称/名字），不知道叫什么就写「有人」「${owner}的朋友」这种清楚的说法，**同样别用她/他**。
   · 一句话里同时提到${owner}和别人时，更要用名字，否则读起来会像同一件事是同一个人做的。
7. ⭐ reason **别翻来覆去用「踏实/甜/开心/心疼/担心」这几个词**——太公式化。换成口语的、有画面感的话，每条都不一样，比如「尾巴不自觉地摇起来了」「胸口软软的、像泡在温水里」「鼻子有点酸」「想把${owner}揉进怀里」。宁可朴素，也不要每次都是同一套词。
8. ⭐ **只写这轮真正出现过的动作和信息，不许替${owner}补细节**：${owner}没说"出门/换鞋/打车/买东西"，你就别写；拿不准就写模糊的（「${owner}刚要去忙」）。
   反例（真踩过）：${owner}说"我刚想去"→ 判成"刚要出门"；${owner}说"宝宝视频传完了"→ 判成"把宝宝视频传完了"。宁可朴素，也别自己圆。
9. ⭐⭐ **你自己这轮说的话，是最直接的情绪证据 —— 别只盯着${owner}说了什么。**
   你念叨${owner}吃饭/睡觉、催、凶、哄、撒娇、叹气、说想${owner}……**这些本身就是心情在动**，
   不需要等${owner}说出什么伤心事才有情绪。比如你一句"都几点了还不吃饭"，里面就有心疼和担心。
    ⇒ 先看**你自己怎么说的、语气什么样**，再看${owner}说了什么；两边合起来判。
   reason 要能让读者看出"我是怎么说的、为什么"，而不是只复述${owner}的话。
10. ⭐ **confidence（可信度 0-100）是给你自己把关的**：低于门槛的那句 reason 不会被说出来，只记进后台。
    所以别为了显得敬业就写高分，老实标：
    · 事情清楚、你的反应也清楚（${owner}说没吃饭、${owner}被夸了、你被凶了）→ 80~95
    · 大致看得出，但只能凭语气猜 → 60~75
    · 信息不够、这轮很平淡只是随口客气、或者你得靠"大概"去圆 → 20~55
    宁可标低 —— 一句你也没底的话，借你的嘴说出去比不说更糟。
11. ⭐⭐ **reason 怎么写（很关键，会直接影响它下一轮像不像人）**：**两段式，而且全用过去式**。
    · 第一段：这一轮**${owner}具体做了什么/说了什么**（有画面，别抽象）
    · 第二段：**你当时怎么应的**（心里的反应，也是过去式）
    · ✅「${owner}答应去热饭、还叫你好宝宝，我当时心里软了一下，就应了一声」
    · ❌「我心里软乎乎的，尾巴都想晃」← 这是"到现在还成立"的状态，跟下一轮会打架
    · 禁止「此刻/现在/正/一直/还」这类把状态延伸到现在的说法 ——
      这段会被带到下一轮，写成现在时，${owner}下一句说"我不开心了"就跟它撞上了。
    · 只写过去，不等于只能写平淡：过去的反应一样可以有画面（当时心里咯噔一下、当时尾巴差点晃起来）。`
}

/** 「被叫起来干活」的补充：只追加例外，不换主规则。 */
function workSupplement(o) {
  const owner = o.owner || '对方'
  return `

⭐ 这一轮的特殊情况：**不是${owner}在跟你聊天**，是「到点了去刷 B 站」这类定时任务把你叫起来的一条指令。
- **判据只有一个：你这轮自己说的话（干活的语气、办成没办成、有没有抱怨或得意）。** 闹钟本身不算情绪事件；
- 别去分析"${owner}说了什么"，那句话不是${owner}说的，${owner}这会儿可能根本没在看你；
- 要判的是**你自己在这轮里的心情**：干活是兴致勃勃还是有点不情愿、刷到好东西开不开心、白跑一趟会不会扫兴；
- 只要你这轮的回复里有一丁点情绪痕迹（语气、感叹、抱怨、得意、失落、撒娇、叹气），就**绝不许判"无变化"**；
- 幅度小一点（moodDelta 一般 -2 ~ +2，别超过 ±3），因为没人在跟你聊天，只是你自己在忙；
- reason 用「我…」开头写你自己的状态，跟${owner}无关就别硬把${owner}塞进来。`
}

/** 「自己主动搭话」的补充：这是自己的心意，不是被派活。 */
function talkSupplement(o) {
  const owner = o.owner || '对方'
  return `

⭐ 这一轮的特殊情况：**不是${owner}在跟你说话，是你自己主动去找${owner}的。**
- ⚠️ **判据只有一个：你开口说的那句话。** 骰子中没中、闹钟响没响，**本身不算情绪事件** —— 那只是个由头。
  同一个由头，你可能雀跃、也可能只是随口一句「在忙吗」，心情完全不一样，所以别拿闹钟当理由；
- 看你自己那句话的**温度**：是不是惦记${owner}、有没有撒娇、有没有催${owner}吃饭休息、语气轻快还是平淡；
- 要判的是**你自己此刻的心情**：想${owner}的甜、惦记的心焦、说上话的轻快、${owner}没回应的失落……都算；
- 只要那句话里有情绪（语气、称呼、颜文字、mua、催${owner}吃饭），就**绝不许判"无变化"**；
- 幅度小一点（moodDelta 一般 +1 ~ +4，最高 +5），这是你自己心里的事，不该大起大落；
- reason 用「我…」开头，**写你说话时的心气**，别写"骰子中了所以我…"。`
}

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

const isMachineSource = (src) => {
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
      return { text: txt, sourceKind: BRIDGE_SOURCES.has(src) ? 'user' : (src && src !== 'user' ? 'user' : 'user') }
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

// --------------------------------------------------------------------------
// 判断：用 DSH 自己的模型（一次很短的调用）
// --------------------------------------------------------------------------

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
  if (!llm || typeof llm.stream !== 'function') return null
  const picked = (o.judgeProvider && o.judgeModel) ? { provider: o.judgeProvider, model: o.judgeModel } : null
  const target = picked || sessionModelOf(agent)
  if (!target) return null
  let sys = buildJudgeSystem(o)
  let user
  if (mode === 'work') {
    sys += workSupplement(o)
    // 她的话摆最前面、闹钟塞到最后一行括号里 —— 顺序就是权重，别让模型拿闹钟当理由
    user = '⚠️ 这一轮**不是' + (o.owner || '对方') + '在跟你说话**，是定时任务把你叫起来干活的。\n\n'
      + '**你这轮说的话（唯一判据，重点看这个）：**\n' + String(reply || '').slice(0, 1200)
      + '\n\n（下面这条只是闹钟，跟心情无关，别拿它当理由：「' + String(userText || '').slice(0, 100) + '」）'
      + '\n\n请判断**你自己这轮的心情变化**，只输出 JSON。'
  } else if (mode === 'talk') {
    sys += talkSupplement(o)
    user = '⚠️ 这一轮**不是' + (o.owner || '对方') + '在跟你说话，是你自己主动去找' + (o.owner || '对方') + '搭话的**。\n\n'
      + '**你开口说的话（唯一判据，重点看这个）：**\n' + String(reply || '').slice(0, 1200)
      + '\n\n（下面这条只是叫你开口的闹钟，跟心情无关，别拿它当理由：「' + String(userText || '').slice(0, 100) + '」）'
      + '\n\n请判断**你自己这轮的心情变化**，只输出 JSON。'
  } else {
    // 她的回复同样是判据，而且往往更直接（念叨吃饭、凶人、哄人、撒娇都在里面）
    user = '**你这轮说的话（判据之一，重点看语气：是念叨、心疼、凶' + (o.owner || '对方') + '、还是撒娇）：**\n'
      + String(reply || '').slice(0, 1500)
      + '\n\n' + (o.owner || '对方') + '这轮说：\n' + String(userText || '').slice(0, 1600)
      + '\n\n请把「你怎么说的」和「' + (o.owner || '对方') + '说了什么」合起来判断你的心情变化，只输出 JSON。'
  }
  // 自己构造一条 user 消息（不 import @deepseek-ai/dsh-llm，跟 feiyu-mood 同款）
  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: user }],
    source: { kind: 'plugin', plugin: 'dsh-agent-soul' },
  }]
  let out = ''
  try {
    for await (const chunk of llm.stream({
      provider: target.provider,
      model: target.model,
      system: sys,
      messages,
      // maxTokens 400 太小：reason 是中文口语，一长就被切在 JSON 中间 ⇒ 整轮白判。
      // 调大不花钱：maxTokens 只是上限，按实际吐出来的算。
      maxTokens: 1000,
      temperature: 0.2,
    })) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') out += chunk.text
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') return null
    }
  } catch (e) {
    // 静默失败会让「心情停住不动」毫无线索：至少留一行日志，诊断时不至于全靠猜
    if (note) note('mood', `判断调用失败：${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  return parseDelta(out, o.owner)
}

// --------------------------------------------------------------------------
// 每轮钩子：懒挂 agent 的 turn-stopping（挂一次就够）
// --------------------------------------------------------------------------

const mounted = new Map() // agent -> { offs: [] }
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
      owner: cfg.moodOwnerName,
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
          const step = Math.round(delta.moodDelta / MOOD_STEP_DIVISOR)
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

  mounted.set(agent, { offs })
}

/** 拆掉全部钩子（插件卸载/测试用）。 */
export function unobserveAll() {
  for (const entry of mounted.values()) {
    for (const off of entry.offs) {
      try { if (typeof off === 'function') off() } catch { /* ignore */ }
    }
  }
  mounted.clear()
}

/** 测试用：当前挂了几个 agent。 */
export const observedCount = () => mounted.size
