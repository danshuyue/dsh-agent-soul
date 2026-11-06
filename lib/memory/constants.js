/**
 * 记忆引擎 · constants.js
 * 由 lib/memory.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */



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
  // ---- 主人是谁（2026-11-04）----
  //
  // 这三个键是**唯一**的默认值来源：store.js 的 DEFAULT_CONFIG 直接引用它们，
  // 提示词里只读配置，不再写死「树树」「男生」「伴侣」。
  //
  // 为什么默认空串而不是树树：这个包是给别人装的。默认写死一个人的名字，
  // 陌生人装完就被告知「你是树树的伴侣」「树树是男生」—— 那不是配置，
  // 那是把作者的生活当成了产品设定。
  //
  // 空串的语义是「不知道」，不是「叫空名字」：提示词里所有依赖它的整句都省略
  //（见 mood.js buildJudgeSystem 的 aliasLine 同款写法），并每隔一小时记一条
  //  一次性日志提醒去设置页填。记忆 / 笔记 / 日记不依赖它，照常工作。
  ownerName: '',
  /** 主人的性别：'male' | 'female' | ''。只影响判定提示词里「写他/她算不算错」那一行。 */
  ownerGender: '',
  /** 关系定位，自由文本（如「伴侣」「搭档」「主人」）。空串 = 不声明关系。 */
  relationship: '',
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
  /**
   * 每日维护时段（0-23 本地时间，**0 = 不限制**）。
   *
   * 2026-11-04：这个参数从加入起就只被 clamp、从没被读过 —— 死配置。
   * 现在真正接上了，但默认值从 4 改成 0：
   * 原来写 4 却没人读，所以实际行为一直是「每 10 分钟维护一次」。
   * 直接接上 4 会让维护频率骤降到一天一次，属于改了配置却没改代码的那种「静默行为变更」。
   * 想要「只在凌晨整理」的人自己设成 4 就行，设了才按天跑。
   */
  dailyHour: 0,
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
