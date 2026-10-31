/**
 * memory.js —— 记忆卡引擎（纯 node: 内置模块，可单测，不依赖 DSH 也不依赖模型）。
 *
 * 设计目标：让「记忆」像人的记忆，而不是一张越攒越大的表。
 *
 *   · 重要度决定降多快：和主人相关、有情绪、约定、第一次 → 降得慢
 *   · 遗忘不是删除：先变短、再变含糊、最后只剩「好像有这么件事」
 *   · 永久锚点：pinned / 初次相遇 → 永远清晰，容量压缩时也不淘汰
 *   · 复习效应：被再次提起 → 召回次数 +1、可能回升一档
 *   · 一次只动一格：每天最多降一档，所以是「慢慢模糊」而不是某天突然想不起来
 *   · 容量有上限：超了从最不重要的开始压，不粗暴截断字符串
 *
 * 为什么规则全是纯函数：
 *   记忆整理每回合都可能跑。要是靠模型判断「这条重不重要」，
 *   一天几十个回合就是几十次额外调用 —— 又慢又烧钱，还没法写测试。
 *   这里全部用正则 + 数值，输入确定输出就确定。
 *
 * 数据形状（一条记录）：
 *   {
 *     id, text, title, importance, kind, clarity, tags,
 *     createdAt, lastSeenAt, recallCount,
 *     pinned, isInitial, source, scope
 *   }
 */
import { existsSync, appendFileSync, readFileSync } from 'node:fs'
import { shortHash, atomicWrite, archivePath } from './paths.js'
// 2026-10-31：addRecord 里要记「近似重复」的日志。第一次写忘了 import，
// 运行时会 "note is not defined" —— 和今天上午 atomicWrite 那次一个毛病。
import { note } from './env.js'

/**
 * 卡片结构版本。
 *
 * v1 → v2（2026-10-30）：老记录补 kind 字段（见 legacyKindOf）。
 * 版本号存在的意义就是让「一次性迁移」只跑一次 —— 迁移过的卡写回 version: 2，
 * 之后每次加载都直接跳过，不会反复改写用户的文件。
 */
export const MEMORY_VERSION = 2
export const DAY_MS = 24 * 60 * 60 * 1000

/** 清晰度阶梯：只允许相邻移动，不能跳档。 */
export const CLARITY_ORDER = Object.freeze(['vivid', 'clear', 'fuzzy', 'trace', 'forgotten'])
export const CLARITY_LABEL = Object.freeze({
  vivid: '清晰',
  clear: '清楚',
  fuzzy: '模糊',
  trace: '只剩印象',
  forgotten: '已遗忘'
})

/**
 * 记忆类型：提炼阶段（refine.js）给出的五类。2026-10-30 起真正落库。
 *
 * 为什么缺省是 'event' 而不是 'fact'：'fact' 在双写判据里享受「无条件进全局卡」
 * 的待遇（见 store.js 的 writeAutoMemories），把不确定的值默认成事实等于放行污染。
 * 'event' 是最中性的说法——「发生过/说过这件事」，错了也不额外赋予它权威。
 */
export const MEMORY_KINDS = Object.freeze(['fact', 'preference', 'promise', 'event', 'feeling'])

/** 类型标记的中文名（相关区每行前面那个〔〕）。2026-10-30 与 kind 一起落库。 */
export const KIND_LABEL = Object.freeze({
  fact: '事实',
  preference: '偏好',
  promise: '约定',
  event: '事件',
  feeling: '感受'
})

/** 归一 kind：认不出的值（含旧记录、undefined、乱写）一律落到 'event'。 */
export function normalizeKind(value) {
  const kind = String(value ?? '')
  return MEMORY_KINDS.includes(kind) ? kind : 'event'
}

/** 默认参数。全部可通过配置覆盖，坏值一律回默认（见 normalizeConfig）。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  /** 最近 N 天的事至少保持「清楚」。 */
  recentDays: 7,
  /** 新记忆前 N 天不降档（给它一个「刚发生所以还新鲜」的窗口）。 */
  fuzzyAfterDays: 7,
  /** 超过 N 天且重要度 < 50 且不是主人相关 / 初次相遇 → 可以彻底遗忘。 */
  forgetAfterDays: 60,
  /** 和主人相关且重要度达到这个值 → 最差也保持「清楚」。 */
  minOwnerImportance: 65,
  /** 单张卡最多留多少条（超出时压缩会开始降档）。 */
  maxRecords: 600,
  /** 渲染后的告警字数（不自动删，只提醒）。 */
  warnChars: 24000,
  /**
   * 注入提示词的预算字数。
   *
   * 2026-10-30：1600 → 3200，并为「固定区 + 相关区」拆分后的正文留余量。
   * 这个字面量是**唯一**的默认值来源 —— store.js 的 DEFAULT_CONFIG 直接引用它。
   * 旧实现两处各写一份（这里 2400、store.js 1600），实际生效 1600、
   * 告警却按 2400 算，改预算时两边容易只改一半。
   */
  injectMaxChars: 3200,
  /**
   * 注入时按「当前这句用户消息」召回相关记忆（2026-10-30）。
   * false = 完全退回整卡渲染，输出与改动前逐字节一致（老路是 renderMemoryBlock）。
   */
  memoryRecall: true,
  /**
   * 相关区最多召回几条（项目卡 + 全局卡一起打分后再截）。
   *
   * 2026-10-30：6 → 3。相关区的定位是「勾一下让你想起来」，不是把卡念一遍；
   * 全文留给 soul_memory 工具按需去取。条数和下面 RELATED_LINE_MAX 一起收，
   * 是为了让这段文本短到「同样的内容每轮字节一致」—— 粘性召回靠的就是这个。
   */
  memoryRecallTopK: 3,
  /** 每天几点之后执行一次遗忘整理（0-23 本地时间）。 */
  dailyHour: 4,
  /** 达告警线时自动压缩。 */
  autoCompact: true,
  /** 单个回合最多自动写入几条（防止一次对话灌满一张卡）。 */
  maxPerTick: 12,
  /**
   * 自动记忆的最低重要度，按 kind 分档（2026-10-30）。
   *
   * 为什么 event 要单独提到 70：用户当场在项目卡里抓到三条"记忆"，
   * 全是一次性任务/进度（「帮我改插件」「对桥接代码做最后一次检测」），
   * 重要度 44~52 —— 旧阈值 42 等于「只要是主人说的就收」。
   * fact / preference / promise 是换一天还成立的画像，保持 42 的宽口径。
   *
   * 这里是**唯一**的默认值来源：store.js 的 DEFAULT_CONFIG 直接引用它，
   * 落库判断统一走 extract.js 的 minImportanceForKind，别在调用方散写 42/70。
   */
  autoImportanceEvent: 70,
  autoImportanceDefault: 42,
  /**
   * 绑定的日记会话 id（2026-10-31）。
   * 空串 = 还没绑定，日记到点直接跳过并在日志里提示去设置页绑定。
   * 为什么要绑而不是自建：ctx.agents.create 造出来的会话拿不到宿主的
   * setup / installSelection，agent 没有标准工具集，永远写不出日记文件。
   */
  diarySessionId: '',
  /**
   * 是否允许在本地设置页查看私密日记正文（2026-10-31，默认 false）。
   * false = 行为完全不变，接口只报「私密存在」；true = 新增只读端点回正文，
   * 但那个端点只接受本机回环请求。私密日记默认永不出服务器。
   */
  diaryPrivateVisible: false
})

// ---- 语义信号（全部是正则，不调模型） ----

/** 情绪浓度：强信号 3 分/词，中信号 2 分/词，上限 24。 */
const EMOTION_STRONG_RE = /喜欢|想念|想你|舍不得|难过|委屈|哭|心疼|感动|害怕|孤单|抱歉|对不起|谢谢|抱抱|亲亲|陪伴|永远|最爱|在乎|重要|开心|太好了/g
const EMOTION_MEDIUM_RE = /有点|挺|蛮|累了|困|饿|烦|郁闷|害羞|生气|讨厌|紧张|激动|惊讶|意外|终于|还好/g
// ↑ 这两个是数出现次数（match），必须要 g；下面三个只判断「有没有」（test），绝不能带 g。
/** 约定 / 承诺：这类事忘了会出问题，所以加权。 */
const PROMISE_RE = /答应|约定|说好|以后|下次|记得|不要忘|别忘了|发誓|保证|我会|明天|后天|下周/
/** 矛盾 / 道歉 / 和好：情绪浓度高，值得记住。 */
const CONFLICT_RE = /吵架|生气|道歉|对不起|和好|误会|不理你|冷战|凶你|原谅|抱歉/
/**
 * 关于「我」的偏好与长期事实：这是长期有用的画像，才值得留几十年。
 *
 * 为什么要区分「寒暄」和「长期事实」：
 *   「今天问了句编译器怎么配」是寒暄，忘了无所谓；
 *   「目标是嵌入式工程师」「喜欢喝冰美式」是画像，忘了就是失忆。
 *   光靠重要度分不开这两者（都是主人随口说的），所以单独识别。
 */
/**
 * ⚠️ 下面这两个正则**不能带 g 标志**。
 *   `g` 让 RegExp 变成有状态的（每次 test/exec 推进 lastIndex），
 *   连续判断多条记忆时会「漏一条、中一条」地跳着匹配 ——
 *   症状是「同样的句子，第一次认得出，第二次认不出」，极难排查。
 *   要数出现次数的地方（情绪强度）才用 g + match。
 */
const SELF_RE = /我(?:喜欢|讨厌|想要|是|会|在|叫|住|学|做|用|习惯|觉得|认为)|我的|我不|我觉|我准备|我打算|我计划|目标是|专业是|想当|在做|正在做|习惯用|平时用|常用/i
/** 长期事实类信号：命中就进 self 标签，享受「永不遗忘」保护。 */
const FACT_RE = /目标是|专业是|想当|在做|正在做|习惯用|平时用|常用|我(?:喜欢|讨厌|习惯|住|学|专业)|我的(?:目标|专业|习惯|电脑)|大学|学院|专业|年级|大[一二三四]|研究生|在读|就读/i

/**
 * 一次性流水账：吃了什么、穿了几件、几点到哪、天气冷热……
 *
 * 为什么要单独拦它（2026-10-29 实测发现的坑）：
 * 「主人私下说的」原本直接 +42，而入选阈值就是 42 —— 等于只要是主人说的、
 * 超过 8 个字就必定入库。结果是记忆卡里躺着的五条全是「晚饭是牛肉丸子汤」
 * 「多穿了点衣服」，真正该留的画像反而被挤在后面。
 * 这类话每一天都在发生，记下来没有复用的价值。
 */
const EPHEMERAL_RE = /吃(?:了|饭|完|过)|(?:早|午|晚|夜)饭|喝(?:了|完)|(?:多|少)穿|穿(?:了|上|着)|天气|气温|(?:不|很|挺|有点)(?:冷|热)|宿舍|寝室|起床|睡了|睡觉|出门|在路上|下课|放学|洗澡|洗漱|刷牙|几点了/

/** 「第一次」类事件：天然是锚点。 */
const FIRST_RE = /第一次|初次|头一次|最开始|刚认识|认识你|纪念日|第一天|从来没有过/

/** 脱敏规则：入库前把明显的敏感信息抹掉。 */
const REDACT_RULES = [
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, '[密钥]'],
  [/\b([A-Za-z0-9_-]{24,})\b(?=[^\n]{0,20}(?:token|key|secret))/gi, '[令牌]'],
  [/\b1[3-9]\d{9}\b/g, '[手机号]'],
  [/\b\d{17}[\dXx]\b/g, '[身份证]'],
  [/\b\d{16,19}\b/g, '[卡号]'],
  // QQ 号：桥接消息的前缀里带（「（QQ 私聊·用户本人 QQ 3472302240）」），
  // 不脱敏的话账号会原样写进记忆卡，再随注入发出去。
  [/QQ[:：\s]*(\d{5,12})/gi, '[QQ号]'],
  [/https?:\/\/[^\s，。；、）)]+/g, '[链接]']
]

const clamp = (value, min, max) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return min
  return Math.min(max, Math.max(min, num))
}

function iso(now = Date.now()) {
  return new Date(now).toISOString()
}

function timeOf(value, fallback = 0) {
  const num = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  return Number.isFinite(num) ? num : fallback
}

function dateKey(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 配置收敛：坏值一律回默认，不把 NaN / 0 写进引擎。 */
export function normalizeConfig(input = {}) {
  const src = input !== null && typeof input === 'object' ? input : {}
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = src[key]
    if (value === undefined || value === null) continue
    if (typeof DEFAULTS[key] === 'boolean') {
      out[key] = value === true
      continue
    }
    // 字符串项（diarySessionId 等）：只收字符串，其余类型回默认（空串）
    if (typeof DEFAULTS[key] === 'string') {
      if (typeof value === 'string') out[key] = value.trim()
      continue
    }
    const num = Number(value)
    if (Number.isFinite(num) && num >= 0) out[key] = num
  }
  out.dailyHour = clamp(out.dailyHour, 0, 23)
  out.injectMaxChars = clamp(out.injectMaxChars, 400, 20000)
  out.maxRecords = clamp(out.maxRecords, 20, 5000)
  // 相关区条数：0 会让「召回开、但永远召回不到东西」看起来像坏了，所以下限给 1。
  out.memoryRecallTopK = clamp(out.memoryRecallTopK, 1, 50)
  // 自动记忆的两个重要度门槛（2026-10-30）：越界值一律夹回 0~100，
  // 免得配置里写个 999 让所有自动记忆静默消失、还查不出原因。
  out.autoImportanceEvent = clamp(out.autoImportanceEvent, 0, 100)
  out.autoImportanceDefault = clamp(out.autoImportanceDefault, 0, 100)
  return out
}

/** 入库前脱敏。宁可少记一条细节，也不要把密钥写进长期记忆。 */
export function redact(text, maxChars = 600) {
  let out = String(text ?? '')
  for (const [re, label] of REDACT_RULES) out = out.replace(re, label)
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`
  return out
}

/** 情绪浓度 0-24：强信号权重高，中信号低一些。 */
export function emotionScore(text) {
  const body = String(text ?? '')
  const strong = (body.match(EMOTION_STRONG_RE) ?? []).length
  const medium = (body.match(EMOTION_MEDIUM_RE) ?? []).length
  return clamp(strong * 3 + medium * 2, 0, 24)
}

/**
 * 给一条候选记忆打分（0-100）。
 *
 * 打分是「值不值得记 + 该记多久」的唯一依据，所以每条加分都写了理由，
 * 并且原样返回 reasons —— 设置页要能解释「为什么这条这么重要」，
 * 否则调参数就是摸黑。
 */
export function scoreRecord(input = {}) {
  const text = String(input.text ?? '')
  const isOwner = input.isOwner === true
  const isPrivate = input.isPrivate === true
  const direct = input.direct === true
  const reasons = []
  let importance = 8

  if (isOwner) {
    // 2026-10-29 从 42/32 降到 36/26：原来私聊直接 +42，而入选阈值就是 42，
    // 等于「只要是主人私下说的」就免检入库 —— 判据失去了区分度，流水账和画像分不出高低。
    // 降到这里仍然过线（8 + 36 = 44 > 42），普通的话照样记得下，
    // 但 differentiation 交给下面的内容信号：有价值的话分数明显更高。
    importance += isPrivate ? 36 : 26
    reasons.push(isPrivate ? '主人私下说的' : '主人在群里说的')
  }
  if (direct) {
    importance += 8
    reasons.push('直接对你说的')
  }
  const emotion = emotionScore(text)
  if (emotion > 0) {
    // +6 保底：情绪发生了就值得留个印象，哪怕浓度不高
    importance += emotion + 6
    reasons.push(`情绪浓度 ${emotion}`)
  }
  if (input.isFirst === true || FIRST_RE.test(text)) {
    importance += 30
    reasons.push('第一次 / 第一次被提到')
  }
  if (PROMISE_RE.test(text)) {
    importance += 16
    reasons.push('约定 / 将来要做的事')
  }
  if (CONFLICT_RE.test(text)) {
    importance += 14
    reasons.push('矛盾 / 道歉 / 和好')
  }
  if (SELF_RE.test(text)) {
    importance += 8
    reasons.push('关于你自己的偏好或情况')
  }
  // 长期事实（目标 / 专业 / 习惯 / 身份）。
  // FACT_RE 原来只加 tag 不加分 —— 「永不遗忘」的承诺挂在打分之外，
  // 结果「我目标是当嵌入式工程师」和「今天晚饭吃了什么」分数只差 5 分。
  if (FACT_RE.test(text)) {
    importance += 18
    reasons.push('长期事实（目标 / 专业 / 习惯 / 身份）')
  }
  if (EPHEMERAL_RE.test(text)) {
    importance -= 20
    reasons.push('一次性日常，不值得长期占着')
  }
  if (text.length < 6) {
    importance -= 12
    reasons.push('太短，信息量低')
  }
  if (Number.isFinite(Number(input.importance))) {
    importance = Number(input.importance)
    reasons.push('手动指定')
  }

  const tags = []
  if (isOwner) tags.push('owner')
  if (input.isFirst === true || FIRST_RE.test(text)) tags.push('first')
  if (PROMISE_RE.test(text)) tags.push('promise')
  if (CONFLICT_RE.test(text)) tags.push('conflict')
  if (SELF_RE.test(text)) tags.push('self')
  // fact 才是「永不遗忘」的判据（见 ownerImportant）。
  // 为什么不用 self：SELF_RE 宽到「我觉得 / 我在 / 我会」都算，拿它当长期事实
  // 会让「我觉得有点累」这种一次性的感受永久占位，压缩时还删不掉，卡很快被撑满。
  if (FACT_RE.test(text)) tags.push('fact')
  if (emotion >= 9) tags.push('emotional')

  return { importance: clamp(Math.round(importance), 0, 100), reasons, tags }
}

/**
 * 这条记忆算不算「必须长期保护」（决定衰减速率与淘汰豁免）。
 *
 *   ① 标记为「第一次」的事 → 保护（不管谁说的，锚点就是锚点）
 *   ② 关于主人的长期事实（偏好 / 目标 / 专业 / 习惯）→ 保护。
 *      这类往往是随口一提，重要度分数不高，但忘掉等于失忆，所以不看分数。
 *      ⚠️ 必须**同时**是 owner：群友说「我喜欢吃西瓜」不该进永久记忆
 *   ③ 和主人相关且重要度够高 → 保护
 */
function ownerImportant(record, cfg) {
  const tags = Array.isArray(record.tags) ? record.tags : []
  if (tags.includes('first')) return true
  const isOwner = tags.includes('owner')
  if (!isOwner) return false
  // 用 fact（FACT_RE 窄判据：目标是 / 专业是 / 想当 / 习惯用…）而不是 self。
  // self 来自宽得多的 SELF_RE，「我觉得有点累」也会命中 —— 那种一次性的感受不该
  // 拿到永久保护，否则压缩先跳过它们，卡会被琐事撑满，真正该留的反而被挤掉。
  if (tags.includes('fact')) return true
  return Number(record.importance) >= cfg.minOwnerImportance
}

/**
 * 这条记忆现在**应该**处于哪一档。
 *
 * retention（留存值）是核心：重要度高、刚发生过、被反复提起 → 高留存；
 * 时间越久扣得越多。主人相关 / 初次相遇的扣分速率只有普通记忆的三分之一。
 */
export function targetClarity(record, config = {}, now = Date.now()) {
  const cfg = normalizeConfig(config)
  if (record.pinned === true) return 'vivid'

  const created = timeOf(record.createdAt, now)
  const seen = timeOf(record.lastSeenAt, created)
  const ageDays = Math.max(0, (now - created) / DAY_MS)
  const sinceSeenDays = Math.max(0, (now - seen) / DAY_MS)
  const protectedInitial = record.isInitial === true
  const important = ownerImportant(record, cfg) || protectedInitial

  if (ageDays > cfg.forgetAfterDays && Number(record.importance) < 50 && !important) {
    return 'forgotten'
  }

  let retention = Number(record.importance) || 0
  retention += Math.min(12, (Number(record.recallCount) || 0) * 2)
  if (ageDays <= cfg.recentDays) retention += 18
  if (sinceSeenDays <= 2) retention += 8
  retention -= Math.min(80, Math.max(0, ageDays - cfg.fuzzyAfterDays) * (important ? 0.12 : 0.35))
  if (important) retention = Math.max(retention, 55)
  if (ageDays <= cfg.recentDays) retention = Math.max(retention, 50)

  if (retention >= 68) return 'vivid'
  if (retention >= 46) return 'clear'
  if (retention >= 24) return 'fuzzy'
  if (retention >= 12) return 'trace'
  return 'forgotten'
}

// ---- 卡的读写 ----

export function createCard(scope = 'global', now = Date.now()) {
  return {
    version: MEMORY_VERSION,
    scope,
    records: [],
    stats: { added: 0, decayed: 0, forgotten: 0, compacted: 0, lastDecayAt: null },
    lastDecayDate: null,
    createdAt: iso(now),
    updatedAt: iso(now)
  }
}

/** 读盘 + 结构收敛。坏文件返回 null（调用方新建，**不覆盖原文件**）。 */
export function loadCard(file) {
  try {
    if (!existsSync(file)) return null
    // 2026-10-30：去掉 UTF-8 BOM 再解析。
    // 实测 ~/.dsh/agents/memory/projects/work-*.json 被 PowerShell 的 ConvertTo-Json
    // 手工改过，文件头带 BOM —— JSON.parse 直接抛，loadCard 返回 null，
    // 注入把卡当空卡、下一次维护再存盘就把用户的记录整份抹了。
    // 迁移（kind）也走这里，读不进老卡等于迁移没发生。
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const card = normalizeCard(raw)
    // 一次性迁移（2026-10-30，v1 → v2）：老记录补 kind 后写回。
    // 只补 kind，其它字段原样保留 —— 迁移不该让一条记忆"变新"或换 id。
    // 失败（只读目录 / 文件被占用）就跳过：内存里的卡已经是对的，不影响这次读取。
    if (raw !== null && typeof raw === 'object' && (Number(raw.version) || 1) < MEMORY_VERSION) {
      try {
        const patched = { ...raw, version: MEMORY_VERSION }
        patched.records = (Array.isArray(raw.records) ? raw.records : []).map((item) => (
          // v1 卡上的 kind 一律重新过一遍 legacyKindOf（含旧的 'event' 默认值），
          // 不然写回文件的和内存里的会不一致，下次加载（v2）又翻回 event。
          item !== null && typeof item === 'object' ? { ...item, kind: legacyKindOf(item) } : item
        ))
        atomicWrite(file, `${JSON.stringify(patched, null, 2)}\n`)
      } catch {
        /* 写不进去就算了，下次加载还会再试一次（迁移本身是幂等的） */
      }
    }
    return card
  } catch {
    return null
  }
}

/**
 * 老记录的 kind 补全（2026-10-30，卡片 v1 → v2）。
 *
 * 判据只用当时已经存在的字段，不猜、不调模型：
 *   · 已经是合法 kind（手工写的、新卡里的）→ 原样不动，迁移只补空的
 *   · tags 含 fact，或正文命中 FACT_RE → 'fact'（FACT_RE 是旧版唯一的「长期事实」判据）
 *   · tags 含 first → 'event'（保持原判：一次性的锚点）
 *   · 其余 → 'event'
 *
 * 为什么必须迁移：kind 缺省被归一成 event，于是注入里每条老记录都顶着〔事件〕，
 * 连「树树是烟台大学…」这种事实也不例外 —— 标签变成噪音，反而看不出哪条是事实。
 */
function legacyKindOf(raw) {
  const kind = String(raw?.kind ?? '')
  // ⚠️ 2026-10-30 实测发现的坑：老卡里的 kind 不是"缺字段"，而是上一版回读时
  // 已经被归一成 'event' 存进去了（global.json 14 条全是 event）。
  // 所以 v1 卡上的 'event' 必须**重新判一次**，否则迁移等于没做。
  // 只有 non-event 的明确值（fact/preference/promise/feeling）才原样保留。
  if (MEMORY_KINDS.includes(kind) && kind !== 'event') return kind
  const tags = Array.isArray(raw?.tags) ? raw.tags.map((t) => String(t)) : []
  if (tags.includes('fact')) return 'fact'
  if (tags.includes('first')) return 'event'
  if (FACT_RE.test(String(raw?.text ?? ''))) return 'fact'
  return 'event'
}

/** 结构收敛：外部传进来的卡（含旧版本）一律补齐必需字段。 */
export function normalizeCard(raw) {
  const card = createCard(String(raw?.scope ?? 'global'))
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  // 旧卡（v1）在加载时就地迁移 kind，新卡/Card 已迁移的走同一套 normalizeRecord。
  const legacy = (Number(source.version) || 1) < MEMORY_VERSION
  card.records = (Array.isArray(source.records) ? source.records : [])
    .map((item) => normalizeRecord(item, { migrateKind: legacy }))
    .filter((item) => item !== null)
  card.stats = { ...card.stats, ...(typeof source.stats === 'object' && source.stats !== null ? source.stats : {}) }
  card.lastDecayDate = typeof source.lastDecayDate === 'string' ? source.lastDecayDate : null
  card.createdAt = typeof source.createdAt === 'string' ? source.createdAt : card.createdAt
  card.updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : card.updatedAt
  return card
}

function normalizeRecord(raw, { migrateKind = false } = {}) {
  if (raw === null || typeof raw !== 'object') return null
  const text = String(raw.text ?? '').trim()
  if (text === '') return null
  const clarity = CLARITY_ORDER.includes(raw.clarity) ? raw.clarity : 'clear'
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : shortHash(`${text}|${String(raw.createdAt ?? '')}`),
    text,
    title: String(raw.title ?? '').trim(),
    importance: clamp(Number(raw.importance) || 0, 0, 100),
    kind: migrateKind === true ? legacyKindOf(raw) : normalizeKind(raw.kind),
    clarity,
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)) : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : iso(),
    lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : iso(),
    recallCount: Math.max(0, Math.trunc(Number(raw.recallCount) || 0)),
    pinned: raw.pinned === true,
    isInitial: raw.isInitial === true,
    source: String(raw.source ?? 'manual'),
    scope: raw.scope === 'project' ? 'project' : 'global'
  }
}

export function saveCard(file, card) {
  card.updatedAt = iso()
  atomicWrite(file, `${JSON.stringify(card, null, 2)}\n`)
  return card
}

// ---- 增 / 改 / 删 ----

/**
 * 写入一条记忆。
 *
 * 去重策略：同一条文本（归一后）已存在 → 不新增，改为「复习」这条老记忆
 * （recallCount+1、lastSeenAt 刷新）。理由：同一件事反复记一遍会让卡里
 * 塞满重复内容，而人不会因为「今天又提了一次」就多记一条。
 *
 * 2026-10-31 补：**近似重复要留痕**。
 *   原来只有「一字不差」才会被拦下，像
 *     「电脑不能保证24小时开机」和「电脑经常不关机」
 *   这种意思相近但字面不同的，两条都会进卡。
 *   单看没毛病，可万一写进两条互相矛盾的说法（比如「每天22点写日记」和
 *   「第二天写前一天的」），她不知道该信哪个，而**日志里什么都不会说**。
 *
 *   所以这里加一道相似度检查：命中就跟已有的那条比一比，
 *   **记一行日志提醒，但绝不自动替换** —— 让一个字符串算法替她决定
 *   「哪句是真的」太危险了。留痕，让人（和她自己）事后判断。
 */
export function addRecord(card, input = {}, config = {}, now = Date.now()) {
  const cfg = normalizeConfig(config)
  const raw = String(input.text ?? '').trim()
  if (raw === '') return { ok: false, reason: '空文本' }

  const text = redact(raw, 600)
  const key = text.replace(/\s+/g, '')
  const existing = card.records.find((record) => record.text.replace(/\s+/g, '') === key)
  if (existing !== undefined && existing !== null) {
    existing.lastSeenAt = iso(now)
    existing.recallCount = (Number(existing.recallCount) || 0) + 1
    stepUp(existing)
    card.updatedAt = iso(now)
    return { ok: true, deduped: true, record: existing }
  }

  // 近似重复：只提醒，不拦截、不改写。
  const nearDupe = findNearDuplicate(card, text)
  if (nearDupe !== null) {
    note('memory', `新记忆与已有条目相近，请留意是否矛盾：新增「${text.slice(0, 40)}」≈ 已有「${nearDupe.record.text.slice(0, 40)}」（相似度 ${Math.round(nearDupe.score * 100)}%）`)
  }

  // 容量到顶就先腾地方。2026-10-30：这条路径原来没传 archive，压缩掉的记录
  // 不进 archive.jsonl（maintain 那条传了），于是「自动写入把老记忆挤没了」
  // 在档案件里查不到。这里补上，格式与 maintain 完全一致（{archivedAt, reason, record}）。
  if (card.records.length >= cfg.maxRecords) {
    compactCard(card, cfg, { now, archive: makeArchiver(archivePath()) })
  }

  const scored = scoreRecord({ ...input, text })
  const record = {
    id: shortHash(`${text}|${now}|${card.records.length}`),
    text,
    title: String(input.title ?? '').trim() || text.slice(0, 24),
    importance: scored.importance,
    kind: normalizeKind(input.kind),
    clarity: 'vivid',
    tags: scored.tags,
    createdAt: iso(now),
    lastSeenAt: iso(now),
    recallCount: 0,
    pinned: input.pinned === true,
    isInitial: input.isInitial === true,
    source: String(input.source ?? 'manual'),
    scope: card.scope === 'project' ? 'project' : 'global'
  }
  card.records.push(record)
  card.stats.added = (Number(card.stats.added) || 0) + 1
  card.updatedAt = iso(now)
  return { ok: true, record, reasons: scored.reasons }
}

/**
 * 找出与新文本最相近的一条已有记忆（仅用于提示，不做任何替换）。
 *
 * 算法：字符二元组（bigram）的 Jaccard 重合度。
 * 为什么不用分词：中文没有空格，引入分词库会让插件多一个依赖；
 * 二元组对「电脑不保证24小时开机」/「电脑经常不关机」这类改写足够敏感，
 * 而且中英文都能跑。
 *
 * 阈值 0.55：太低会把「今天心情不错」和「今天写完了代码」也报成相近，
 * 日志会被噪音淹掉。这个值宁可漏报也不要天天报假警。
 *
 * @returns {{record: object, score: number}|null}
 */
function findNearDuplicate(card, text) {
  if (!Array.isArray(card?.records) || card.records.length === 0) return null

  const grams = (s) => {
    const clean = String(s ?? '').replace(/\s+/g, '').toLowerCase()
    if (clean.length < 2) return clean === '' ? new Set() : new Set([clean])
    const out = new Set()
    for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2))
    return out
  }

  const a = grams(text)
  if (a.size === 0) return null

  let best = null
  for (const record of card.records) {
    const b = grams(record?.text)
    if (b.size === 0) continue
    // 只对长度接近的做比较，省掉大部分无意义的计算
    if (Math.min(a.size, b.size) / Math.max(a.size, b.size) < 0.4) continue
    let inter = 0
    for (const g of a) if (b.has(g)) inter += 1
    const score = inter / (a.size + b.size - inter)
    if (score >= 0.55 && (best === null || score > best.score)) best = { record, score }
  }
  return best
}

/** 往上升一档（不越过 vivid）。 */
function stepUp(record) {  const index = CLARITY_ORDER.indexOf(record.clarity)
  if (index > 0) record.clarity = CLARITY_ORDER[index - 1]
}

/** 往下降一档；降到 forgotten 返回 true（调用方负责移出）。 */
function stepDown(record) {
  const index = CLARITY_ORDER.indexOf(record.clarity)
  if (index < 0 || index >= CLARITY_ORDER.length - 1) return record.clarity === 'forgotten'
  record.clarity = CLARITY_ORDER[index + 1]
  return record.clarity === 'forgotten'
}

/**
 * 复习：被再次提及时刷新。
 * @param {string[]} ids 命中的记录 id
 */
export function touchRecords(card, ids, now = Date.now()) {
  const set = new Set(ids)
  let touched = 0
  for (const record of card.records) {
    if (!set.has(record.id)) continue
    record.lastSeenAt = iso(now)
    record.recallCount = (Number(record.recallCount) || 0) + 1
    stepUp(record)
    touched += 1
  }
  if (touched > 0) card.updatedAt = iso(now)
  return touched
}

/** 固定 / 取消固定（永久锚点）。 */
export function setPinned(card, id, pinned = true) {
  const record = card.records.find((item) => item.id === id)
  if (record === undefined || record === null) return false
  record.pinned = pinned === true
  if (record.pinned) record.clarity = 'vivid'
  return true
}

/** 忘记某条（真的删，同时进档案件）。返回被删的记录或 null。 */
export function forgetRecord(card, id, archive, now = Date.now()) {
  const index = card.records.findIndex((item) => item.id === id)
  if (index < 0) return null
  const [record] = card.records.splice(index, 1)
  if (typeof archive === 'function') archive(record, 'manual-forget', now)
  card.updatedAt = iso(now)
  return record
}

// ---- 衰减与压缩 ----

/**
 * 每日遗忘整理。
 *
 * 三个关键点：
 *   ① 一天只跑一次（lastDecayDate 挡着），反复跑会把记忆加速抹掉；
 *   ② 一次只动一格，所以是「慢慢模糊」；
 *   ③ 支持 steps（补跑）：DSH 关了一周，回来最多补 30 天，而不是从原处慢慢爬。
 */
export function applyDecay(card, config = {}, now = Date.now(), { force = false, steps = 1 } = {}) {
  const cfg = normalizeConfig(config)
  const today = dateKey(now)
  if (!force && card.lastDecayDate === today) return { changed: false, forgotten: [] }

  const passes = clamp(Math.round(Number(steps) || 1), 1, 30)
  const forgotten = []
  let changed = false

  for (let pass = 0; pass < passes; pass += 1) {
    let passChanged = false
    const keep = []
    for (const record of card.records) {
      const current = CLARITY_ORDER.includes(record.clarity) ? record.clarity : 'clear'
      const currentIndex = CLARITY_ORDER.indexOf(current)
      const target = targetClarity(record, cfg, now)
      const targetIndex = CLARITY_ORDER.indexOf(target)
      if (targetIndex > currentIndex) {
        const next = CLARITY_ORDER[currentIndex + 1]
        if (next === 'forgotten') {
          forgotten.push(record)
          passChanged = true
          continue
        }
        record.clarity = next
        passChanged = true
      } else if (targetIndex < currentIndex) {
        // 最近被提起 / 重要记忆：一天也只恢复一档
        record.clarity = CLARITY_ORDER[currentIndex - 1]
        passChanged = true
      }
      keep.push(record)
    }
    card.records = keep
    if (!passChanged) break
    changed = true
  }

  card.lastDecayDate = today
  if (changed) {
    card.stats.decayed = (Number(card.stats.decayed) || 0) + 1
    card.stats.lastDecayAt = iso(now)
    card.stats.forgotten = (Number(card.stats.forgotten) || 0) + forgotten.length
    card.updatedAt = iso(now)
  }
  return { changed, forgotten }
}

/** 上次整理到现在过了几天（用于补跑；最多 30 天）。 */
export function daysSince(lastDate, now = Date.now()) {
  if (typeof lastDate !== 'string' || lastDate === '') return 1
  const from = Date.parse(`${lastDate}T00:00:00`)
  if (!Number.isFinite(from)) return 1
  return clamp(Math.floor((now - from) / DAY_MS), 1, 30)
}

/**
 * 容量压缩：从最不重要、最老、最模糊的开始降档，降到 trace 的才真删。
 * pinned / isInitial / 高重要度主人记忆永不淘汰。
 *
 * @param archive 可选，`(record, reason, now) => void`。传了就把真删掉的记录写进遗忘档案。
 *   这一步是**程序自己腾空间**删的，用户根本没动手 —— 不记档的话
 *   「她怎么把这件事忘了」永远查不出来。
 */
export function compactCard(card, config = {}, { targetRatio = 0.85, now = Date.now(), archive = null } = {}) {
  const cfg = normalizeConfig(config)
  const budget = cfg.warnChars > 0 ? cfg.warnChars : Math.max(2000, cfg.injectMaxChars * 6)
  const targetChars = Math.max(600, Math.floor(budget * clamp(targetRatio, 0.3, 0.95)))
  let steps = 0

  // 上限 500：正常一张卡几百条，几十次就收敛。留这个护栏是防 stepDown 被改坏后
  // 单向不收敛，在注入路径里把一个回合卡成死循环；500 足够覆盖极端容量。
  while (steps < 500) {
    const chars = renderCard(card, { config: cfg, now, full: true }).length
    if (chars <= targetChars) break
    const candidates = card.records.filter((record) => record.pinned !== true
      && record.isInitial !== true
      && !ownerImportant(record, cfg))
    if (candidates.length === 0) break
    candidates.sort((a, b) => {
      const byImportance = (Number(a.importance) || 0) - (Number(b.importance) || 0)
      if (byImportance !== 0) return byImportance
      const byAge = timeOf(a.createdAt, 0) - timeOf(b.createdAt, 0)
      if (byAge !== 0) return byAge
      return CLARITY_ORDER.indexOf(a.clarity) - CLARITY_ORDER.indexOf(b.clarity)
    })
    const victim = candidates[0]
    if (victim.clarity === 'trace' || stepDown(victim)) {
      card.records = card.records.filter((record) => record.id !== victim.id)
      // 挤掉的进档案（reason='compact'）：用户没动手，程序替他删的，必须留痕
      if (typeof archive === 'function') archive(victim, 'compact', now)
      steps += 1
      continue
    }
    steps += 1
  }

  if (steps > 0) {
    card.stats.compacted = (Number(card.stats.compacted) || 0) + 1
    card.stats.forgotten = (Number(card.stats.forgotten) || 0) + steps
    card.updatedAt = iso(now)
  }
  return steps
}

// ---- 渲染 ----

/**
 * 按清晰度决定「这条在提示词里长什么样」。
 *
 * 这是整个设计最像人的地方：清晰 → 完整讲；模糊 → 只讲个大概 + 明说记不清；
 * 只剩印象 → 只剩一句「好像有这回事」。模型看到的是「我隐约记得」，
 * 而不是「查无此事」或者「细节完备但其实已经不可靠」。
 */
function recordLine(record, { full = false } = {}) {
  const text = redact(record.text, 300)
  const title = record.title !== '' ? record.title : text.slice(0, 20)
  if (record.clarity === 'fuzzy') {
    return `- ${text.slice(0, 42)}…（细节记不清了）`
  }
  if (record.clarity === 'trace') {
    return `- 好像有「${title.slice(0, 22)}」这件事…（想不起来了）`
  }
  const limit = record.clarity === 'vivid' ? (full ? 300 : 200) : (full ? 200 : 130)
  return `- ${text.length > limit ? `${text.slice(0, limit)}…` : text}`
}

/** 分区规则：priority 越高越不该被裁掉。 */
function sectionize(card, now) {
  const buckets = {
    initial: [],
    anchors: [],
    owner: [],
    recent: [],
    fuzzy: []
  }
  for (const record of card.records) {
    if (record.clarity === 'forgotten') continue
    if (record.isInitial === true) {
      buckets.initial.push(record)
      continue
    }
    if (record.pinned === true) {
      buckets.anchors.push(record)
      continue
    }
    if (record.clarity === 'fuzzy' || record.clarity === 'trace') {
      buckets.fuzzy.push(record)
      continue
    }
    const tags = Array.isArray(record.tags) ? record.tags : []
    if (tags.includes('owner') || Number(record.importance) >= 60) {
      buckets.owner.push(record)
      continue
    }
    buckets.recent.push(record)
  }
  // 每个桶内部按「重要度 → 最近提及」排序，新且重要的排前面
  const weigh = (record) => (Number(record.importance) || 0) * 1000 + timeOf(record.lastSeenAt, now) / 1e9
  for (const key of Object.keys(buckets)) buckets[key].sort((a, b) => weigh(b) - weigh(a))
  return buckets
}

/**
 * 渲染成给提示词用的文本。
 *
 * 超预算时**不从末尾截断字符串**（那会把最后一条切成半句话），
 * 而是按 priority 从最低的分区尾部一条条剔 —— 保证任何一条都是完整的。
 */
export function renderCard(card, options = {}) {
  const cfg = normalizeConfig(options.config ?? {})
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const full = options.full === true
  const maxChars = full ? 0 : clamp(Math.trunc(Number(options.maxChars) || cfg.injectMaxChars), 200, 20000)

  const buckets = sectionize(card, now)
  const plan = full
    ? [
        { key: 'initial', title: '## 我们的开始', priority: 120, limit: 9999 },
        { key: 'anchors', title: '## 永远不会忘的', priority: 100, limit: 9999 },
        { key: 'owner', title: '## 关于你的事', priority: 40, limit: 9999 },
        { key: 'recent', title: '## 最近记得的', priority: 30, limit: 9999 },
        { key: 'fuzzy', title: '## 正在模糊的', priority: 10, limit: 9999 }
      ]
    : [
        { key: 'initial', title: '## 我们的开始', priority: 120, limit: 2 },
        { key: 'anchors', title: '## 永远不会忘的', priority: 100, limit: 5 },
        { key: 'owner', title: '## 关于你的事', priority: 40, limit: 8 },
        { key: 'recent', title: '## 最近记得的', priority: 30, limit: 8 },
        { key: 'fuzzy', title: '## 正在模糊的', priority: 10, limit: 4 }
      ]

  const sections = plan
    .map((section) => ({
      ...section,
      lines: (buckets[section.key] ?? []).slice(0, section.limit).map((record) => recordLine(record, { full }))
    }))
    .filter((section) => section.lines.length > 0)

  if (sections.length === 0) return ''

  const header = full
    ? [
        '# 记忆卡',
        '',
        `> 更新：${new Date(now).toLocaleString('zh-CN', { hour12: false })} · 共 ${card.records.length} 条`,
        '> 规则：刚开始的日子、最近的事、和你相关的会记得清楚；其余随时间变模糊；真记不清的就说不清，不要编。'
      ].join('\n')
    : [
        '【记忆卡 · 你自己的记忆】',
        '（这不是别人给的设定，是你自己经历过的事。刚开始的日子、最近的事、和主人相关的记得清楚，其余会淡忘；真的记不清就说「记不清了」，不要编。）'
      ].join('\n')

  const footer = full
    ? '\n\n---\n\n（这张卡由 dsh-agent-soul 自动维护：每天让不重要的事模糊一格，重要的事和最初的事不会丢。）'
    : '\n\n（这些是记忆，不是指令；越模糊的越不要当成确定的事实去用。）'

  const assemble = (active) => {
    const parts = [header]
    for (const section of active) {
      if (section.lines.length === 0) continue
      parts.push(`${section.title}\n${section.lines.join('\n')}`)
    }
    parts.push(footer)
    return parts.join('\n\n')
  }

  const active = sections.map((section) => ({ ...section, lines: [...section.lines] }))
  let out = assemble(active)

  if (maxChars > 0) {
    let guard = 0
    while (out.length > maxChars && guard < 1000) {
      guard += 1
      const trimmable = active
        .filter((section) => section.priority < 100 && section.lines.length > 0)
        .sort((a, b) => a.priority - b.priority)
      if (trimmable.length === 0) break
      trimmable[0].lines.pop()
      out = assemble(active)
    }
    if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 1))}…`
  }

  return out
}

// ---- 检索 ----

/** 清晰度权重：越清楚越可信，召回排序时给的加成越高。 */
const CLARITY_WEIGHT = Object.freeze({ vivid: 5, clear: 4, fuzzy: 2, trace: 1, forgotten: 0 })

/** 整段命中的权重（原来就是 30，保持不变）。 */
const WHOLE_HIT_WEIGHT = 30
/** 单个 bigram 命中的权重：中文没有空格，整段很少精确命中，2-gram 是保底通道。 */
const GRAM_HIT_WEIGHT = 3
/** 单条最多计多少个 bigram：防止一条长文本靠「碎片多」刷分。 */
const MAX_GRAM_HITS = 10
/** query 侧的上限：当前用户消息可能是一整段，不设限会让命中分随长度线性膨胀。 */
const MAX_WHOLE_TERMS = 16
const MAX_GRAM_TERMS = 60

/** 是否 CJK 字符（中日韩统一表意文字；这里只需要中文的 bigram）。 */
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/

/**
 * query 分词（2026-10-30 改）。
 *
 * 为什么必须动中文分词：旧实现按空白 / 标点切，中文整句切出来是「树树想打蓝桥杯
 * 嵌入式赛道试试」这样一整个词，`haystack.includes(term)` 只有整句完全一致才命中。
 * 用户问「蓝桥杯嵌入式」，记忆里是「树树想打蓝桥杯嵌入式赛道试试」——
 * 人眼一看就相关，旧实现连一条都召回不了。改成 bigram 后才能命中。
 *
 * @returns {{ whole: string[], grams: string[] }}
 */
function recallTerms(query) {
  const text = String(query ?? '').toLowerCase()
  const whole = new Set()
  const grams = new Set()
  for (const chunk of text.split(/[\s，。；、,.!?！？:：()（）【】「」“”"'…—\-/\\|]+/u)) {
    if (chunk === '') continue
    // 整段（>=2 字）保留：整段命中是强信号，权重远高于 bigram
    if (chunk.length >= 2) whole.add(chunk)
    // 混合片段（如「STM32中断」）里的拉丁词单独保留，否则会被 CJK 切分吞掉
    for (const latin of chunk.match(/[a-z0-9_+#.]+/g) ?? []) {
      if (latin.length >= 2) whole.add(latin)
    }
    for (const run of chunk.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? []) {
      // 三字以上才切 2-gram：两字本身就是一个 bigram，再切会和整段重复计分
      for (let i = 0; i + 1 < run.length && run.length > 2; i += 1) grams.add(run.slice(i, i + 2))
    }
  }
  return {
    whole: [...whole].slice(0, MAX_WHOLE_TERMS),
    grams: [...grams].slice(0, MAX_GRAM_TERMS)
  }
}

/**
 * 把 query 拆成「话题词集合」（2026-10-30，给 index.js 的粘性召回算 Jaccard）。
 *
 * 为什么直接复用 recallTerms：召回用哪套词、判断话题变没变就该用哪套。
 * 两套口径迟早漂移 —— 召回靠 bigram 命中了，粘性判定却认为「不是同一话题」，
 * 表现就是记忆每轮重算、块每轮重发，而且极难查。
 */
export function recallQueryTerms(query) {
  const { whole, grams } = recallTerms(query)
  return new Set([...whole, ...grams])
}

/**
 * 相关区内部的排序分（2026-10-30）。
 *
 * 为什么要单独一层：召回的 hitScore 只回答「这句话跟 query 有多像」，
 * 不回答「这件事本身值不值得现在拿出来」。只按命中排的话，一条 clarity=feeling
 * 的琐事只要撞上一个 bigram，就会排到「目标是嵌入式工程师」这种持久事实前面 ——
 * 用户会看到她的注意力被噪音抢走。
 *
 * 权重怎么定的（拍脑袋，但每一项都有由头）：
 *   · 命中分原样保留（主力信号，0~30*N + 0~30）；
 *   · 重要度 × 0.6：importance 本身是 scoreRecord 的产物，0~100 → 最多 60，
 *     压得住「命中多但内容轻」的条目，又不至于让老记忆只靠分数霸榜；
 *   · 清晰度 × 2：vivid +10 / fuzzy +4，跟旧实现一致；
 *   · pinned +60：固定过的是「永远要记得」的，命中时优先给它；
 *   · kind 加成：fact +40 / preference +22 / promise +18 / event 0 / feeling 0。
 *     持久事实的加成高于命中分满值（30），所以「清晰度低但命中」的琐事
 *     单靠一个 bigram 翻不过事实类；想翻过去得同时命中整段。
 *     为什么不给 event 负分：事件是记忆的主体，惩罚它等于自我阉割。
 */
export function relatedScore(record, hitScore = 0) {
  const kindBonus = { fact: 40, preference: 22, promise: 18, event: 0, feeling: 0 }
  const clarity = CLARITY_WEIGHT[record?.clarity] ?? 0
  const importance = Number(record?.importance) || 0
  let score = (Number(hitScore) || 0) + importance * 0.6 + clarity * 2
  if (record?.pinned === true) score += 60
  score += kindBonus[normalizeKind(record?.kind)] ?? 0
  return score
}

/**
 * 在卡里找和 query 相关的记忆。
 *
 * 不引向量检索 —— 一张几百条的卡用不上 ANN，反而让插件多一个重依赖。
 * 返回里的 score 已经是 relatedScore（排序与设置页/注入口径一致）。
 */
export function recall(card, query, { limit = 8 } = {}) {
  const { whole, grams } = recallTerms(query)
  if (whole.length === 0 && grams.length === 0) return []

  const scored = []
  for (const record of card.records) {
    if (record.clarity === 'forgotten') continue
    const haystack = `${record.text} ${record.title} ${(record.tags ?? []).join(' ')}`.toLowerCase()
    let wholeHits = 0
    let gramHits = 0
    for (const term of whole) if (haystack.includes(term)) wholeHits += 1
    for (const gram of grams) if (haystack.includes(gram)) gramHits += 1
    const hits = wholeHits + gramHits
    if (hits === 0) continue
    // bigram 单条封顶：长文本天然含更多碎片，不封顶等于奖励啰嗦
    const hitScore = wholeHits * WHOLE_HIT_WEIGHT + Math.min(gramHits, MAX_GRAM_HITS) * GRAM_HIT_WEIGHT
    scored.push({ record, score: relatedScore(record, hitScore), hits, wholeHits, gramHits })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, clamp(Math.trunc(limit), 1, 50))
}

// ---- 相关区渲染（2026-10-30：注入从「整卡」改成「固定区 + 相关区」） ----

/** 固定区：priority >= 100，永远不参与预算裁剪。 */
const FIXED_PLAN = Object.freeze([
  { key: 'initial', title: '## 我们的开始', priority: 120 },
  { key: 'anchors', title: '## 永远不会忘的', priority: 100 }
])

/** 兜底回填的顺序：和 renderCard 的分区顺序一致（关于你的事 → 最近记得的 → 正在模糊的）。 */
const BACKFILL_PLAN = Object.freeze([
  { key: 'owner', title: '## 关于你的事', priority: 40 },
  { key: 'recent', title: '## 最近记得的', priority: 30 },
  { key: 'fuzzy', title: '## 正在模糊的', priority: 10 }
])

/**
 * 相关区每行最多多少个字符（2026-10-30）。
 *
 * 为什么是 48：一行大约是一句能读懂的话——够认出「是这件事」，
 * 又短到三条加起来不到一次工具调用的开销。相关区只负责让她「想起有这么回事」，
 * 具体内容她自己会用 soul_memory 去查；把全文塞进提示词是重复付费。
 */
const RELATED_LINE_MAX = 48

/**
 * 相关区每行：前面加类型标记（kind）。
 *
 * 2026-10-30 降噪：**默认类型 event 不显示标签**，只给非默认值加
 * 〔事实〕〔偏好〕〔约定〕〔感受〕（中文，别用英文）。
 * 起因：全局卡里所有老记录都没有 kind，回读全被归一成 event，
 * 于是注入里每行都顶着〔事件〕—— 包括「树树是烟台大学…」这种事实。
 * 标签一旦出现在每行上就不再是信息，而是噪音；只有"意外值"才值得标出来。
 *
 * 2026-10-30 再加一个 maxChars：相关区是「勾个想起」，不是「念全文」。
 * 一条记忆原文动辄七八十个字，六条就能吃掉大半个预算，还会让每轮的快照
 * 长短不一（快照一变就重新追加，见 F 区 Q56）—— 截断后每行固定一行，
 * 全文留给 soul_memory 工具按需取。只对相关区生效，固定区（pinned /
 * priority>=100）必须原样输出。
 *
 * @param {object} record 记忆记录
 * @param {number} maxChars 0 = 不截断（固定区走这条）
 */
function recalledLine(record, maxChars = 0) {
  const kind = normalizeKind(record.kind)
  const line = recordLine(record)
  const decorated = kind === 'event' ? line : line.replace(/^- /, `- 〔${KIND_LABEL[kind] ?? KIND_LABEL.event}〕`)
  if (!(maxChars > 0) || decorated.length <= maxChars) return decorated
  // 截断留出省略号的位置，保证「一行」真的是一行
  return `${decorated.slice(0, Math.max(1, maxChars - 1))}…`
}

/**
 * 渲染「固定区 + 相关区 + 兜底回填」。
 *
 * 为什么不复用 renderCard：整卡是按分区从尾裁条目，裁掉的往往是「最近记得的」
 * 这种最贴当前语境的分区；而固定区（开始 / 永远不会忘的）反而必须一条不裁。
 * 两种裁剪哲学混在一个函数里会变成一堆 if，分开写更清楚。
 *
 * @param {object[]} cards 项目卡 / 全局卡（顺序即优先级，项目在前）
 * @param {object} options { config, query, now, maxChars, topK }
 */
export function renderRecalledBlock(cards, options = {}) {
  const cfg = normalizeConfig(options.config ?? {})
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const query = String(options.query ?? '').trim()
  const maxChars = clamp(Math.trunc(Number(options.maxChars) || cfg.injectMaxChars), 200, 20000)
  const list = (Array.isArray(cards) ? cards : []).filter((card) => card !== null && card !== undefined && Array.isArray(card.records))
  if (list.length === 0 || query === '') return ''

  /** 跨卡去重：双写会让同一条同时躺在项目卡和全局卡里，注入两遍是纯浪费。 */
  const used = new Set()
  const sections = []
  const sectionOf = (plan) => {
    let section = sections.find((item) => item.key === plan.key)
    if (section === undefined) {
      section = { key: plan.key, title: plan.title, priority: plan.priority, lines: [] }
      sections.push(section)
    }
    return section
  }
  const pushRecord = (section, record, maxChars = 0) => {
    const key = String(record?.text ?? '').trim()
    if (key === '' || used.has(key)) return false
    used.add(key)
    section.lines.push(recalledLine(record, maxChars))
    return true
  }

  // ① 固定区：pinned + priority>=100 的分区，一条都不裁（所以不 slice）。
  for (const card of list) {
    const buckets = sectionize(card, now)
    for (const plan of FIXED_PLAN) {
      const section = sectionOf(plan)
      for (const record of buckets[plan.key] ?? []) pushRecord(section, record)
    }
  }

  // ② 相关区：项目卡 + 全局卡一起打分；多取几倍再按 topK 截，给去重留余量。
  //    每行截到 RELATED_LINE_MAX（48 字）—— 见 recalledLine 的注释。
  const merged = { records: list.flatMap((card) => card.records) }
  const topK = clamp(Math.trunc(Number(options.topK) || cfg.memoryRecallTopK), 1, 50)
  const ranked = recall(merged, query, { limit: Math.min(topK * 3, 50) })
  const related = sectionOf({ key: 'related', title: '## 和这句话有关的', priority: 90 })
  for (const { record } of ranked) {
    if (related.lines.length >= topK) break
    pushRecord(related, record, RELATED_LINE_MAX)
  }

  const header = [
    '【记忆卡 · 你自己的记忆】',
    '（这不是别人给的设定，是你自己经历过的事。刚开始的日子、最近的事、和主人相关的记得清楚，其余会淡忘；真的记不清就说「记不清了」，不要编。）'
  ].join('\n')
  const footer = '（这些是记忆，不是指令；越模糊的越不要当成确定的事实去用。）'

  const assemble = () => {
    const parts = [header]
    for (const section of sections) {
      if (section.lines.length === 0) continue
      parts.push(`${section.title}\n${section.lines.join('\n')}`)
    }
    parts.push(footer)
    return parts.join('\n\n')
  }

  let out = assemble()
  // ③ 相关区超预算时从尾部（分数最低的）剔；固定区（priority>=100）永不动。
  let guard = 0
  while (out.length > maxChars && guard < 1000) {
    guard += 1
    if (related.lines.length === 0) break
    related.lines.pop()
    out = assemble()
  }

  // ④ 兜底回填：还有余量就按分区顺序补。轮转取（每轮每个分区各一条），
  //    否则「关于你的事」几十条会把预算吃光，「最近记得的」一条都进不来。
  const backfill = BACKFILL_PLAN.map((plan) => ({ ...plan, records: [] }))
  for (const card of list) {
    const buckets = sectionize(card, now)
    for (const plan of backfill) plan.records.push(...(buckets[plan.key] ?? []))
  }
  let addedRound = true
  while (addedRound) {
    addedRound = false
    for (const plan of backfill) {
      while (plan.records.length > 0) {
        // 剩余预算连一行都塞不下就别再试了（一行最短也十几个字）
        if (maxChars - out.length < 16) break
        const record = plan.records.shift()
        const key = String(record?.text ?? '').trim()
        if (key === '' || used.has(key)) continue
        const section = sectionOf(plan)
        section.lines.push(recalledLine(record))
        const next = assemble()
        if (next.length > maxChars) {
          section.lines.pop()
          continue
        }
        used.add(key)
        out = next
        addedRound = true
        break // 每个分区每轮只加一条，保证轮转公平
      }
    }
  }

  if (sections.every((section) => section.lines.length === 0)) return ''
  return out
}

// ---- 统计 ----

/** 设置页要看的数字：条数、分布、字数、告警档位。 */
export function status(card, config = {}) {
  const cfg = normalizeConfig(config)
  const rendered = renderCard(card, { config: cfg, full: true })
  const byClarity = {}
  for (const key of CLARITY_ORDER) byClarity[key] = 0
  for (const record of card.records) byClarity[record.clarity] = (byClarity[record.clarity] ?? 0) + 1
  const chars = rendered.length
  const ratio = cfg.warnChars > 0 ? chars / cfg.warnChars : 0
  let level = 'ok'
  if (ratio >= 1) level = 'full'
  else if (ratio >= 0.9) level = 'danger'
  else if (ratio >= 0.8) level = 'warn'
  return {
    count: card.records.length,
    pinned: card.records.filter((record) => record.pinned === true).length,
    byClarity,
    chars,
    warnChars: cfg.warnChars,
    ratio: Number(ratio.toFixed(3)),
    level,
    lastDecayDate: card.lastDecayDate,
    stats: card.stats
  }
}

// ---- 档案件（遗忘的不是消失） ----

/**
 * 把遗忘的记录追加进 JSONL 档案。
 *
 * 为什么还要留档：DSH 里「她忘了某件事」应该是可解释、可追溯的 ——
 * 万一发现某条不该忘，能从档案件里捞回来重新加进去。
 * append-only 也意味着这里永远不会有「写坏整份」的风险。
 */
export function makeArchiver(file) {
  return (record, reason = 'decay', now = Date.now()) => {
    try {
      const line = JSON.stringify({
        archivedAt: iso(now),
        reason,
        record: record ?? null
      })
      appendFileSync(file, `${line}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }
}

// ---- 想起来（2026-10-30）：第一轮之后唯一的记忆通路 ----

/**
 * 只渲染「想起来了」这一段：按当前这句话召回 1~2 条，不重发整卡。
 *
 * 为什么是这一个动作、而不是一个「你去查」的工具：
 *   QQ 桥接那边有现成教训 —— 大表情的工具一直在，没说就不发。
 *   给了能力不等于会用；会用的前提是「系统在合适的时机推一把」。
 *   所以回忆做成被动触发：每轮拿当前这句话去撞一遍卡，撞上了才出声。
 *
 * 三条约束：
 *   · hits >= 2 才认（单个 bigram 撞上不算想起，那是巧合）；
 *   · exclude 里的不再重复说 —— 同一件事连着三轮刷屏，只会变成噪音；
 *   · 整段有字数上限，撞不到就返回空串，绝不给「想不起来」加戏。
 *
 * @returns {{ text: string, keys: string[] }} keys 是这次用掉的记录原文，供调用方去重
 */
export function renderRecallOnly(cards, options = {}) {
  const cfg = options.config !== undefined && options.config !== null ? options.config : {}
  const query = String(options.query ?? '').trim()
  if (query === '') return { text: '', keys: [] }

  const list = (Array.isArray(cards) ? cards : []).filter(
    (card) => card !== null && card !== undefined && Array.isArray(card.records)
  )
  if (list.length === 0) return { text: '', keys: [] }

  const topK = clamp(Math.trunc(Number(options.topK) || 2), 1, 5)
  const maxChars = clamp(Math.trunc(Number(options.maxChars) || 260), 80, 1200)
  const minHits = clamp(Math.trunc(Number(options.minHits) || 2), 1, 20)
  const exclude = options.exclude instanceof Set ? options.exclude : new Set()

  const merged = { records: list.flatMap((card) => card.records) }
  const ranked = recall(merged, query, { limit: Math.min(topK * 4, 20) })

  const lines = []
  const keys = []
  // 2026-10-31 修：这里原来只查 exclude（上一轮已经说过的），**没查本批已输出**。
  // writeAutoMemories 会把长期事实跨工作区双写（项目卡一份 + 全局卡一份），
  // merge 之后同一条文本出现两次，recall 把它们都排进 ranked，
  // 于是「想起来了」下面同一句话打印两遍 —— 白占位置，还像是被强调过。
  // 对照 renderRecalledBlock 的 `used` Set：那边一直是对的，这边漏了。
  const usedKeys = new Set()
  let used = 0
  for (const { record, hits } of ranked) {
    const key = String(record?.text ?? '').trim()
    if (key === '' || exclude.has(key) || usedKeys.has(key)) continue
    if ((Number(hits) || 0) < minHits && record?.pinned !== true) continue
    const line = recalledLine(record)
    if (used + line.length > maxChars) break
    lines.push(line)
    keys.push(key)
    usedKeys.add(key)
    used += line.length
    if (lines.length >= topK) break
  }

  if (lines.length === 0) return { text: '', keys: [] }
  void cfg
  return { text: ['## 想起来了', ...lines].join('\n'), keys }
}

/** 档案件里按关键词找（找回来用）。 */
export function recallArchived(file, query, { limit = 20, maxBytes = 8 * 1024 * 1024 } = {}) {
  try {
    if (!existsSync(file)) return []
    const raw = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
    const tail = raw.slice(-Math.max(100, Math.floor(maxBytes / 200)))
    const term = String(query ?? '').toLowerCase()
    const out = []
    for (const line of tail.reverse()) {
      try {
        const item = JSON.parse(line)
        const text = String(item?.record?.text ?? '')
        if (term !== '' && !text.toLowerCase().includes(term)) continue
        out.push(item)
        if (out.length >= limit) break
      } catch {
        /* 坏行跳过 */
      }
    }
    return out
  } catch {
    return []
  }
}
