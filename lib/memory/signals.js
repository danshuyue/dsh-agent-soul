/**
 * 记忆引擎 · signals.js
 * 由 lib/memory.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */



// ---- 语义信号（全部是正则，不调模型） ----

/** 情绪浓度：强信号 3 分/词，中信号 2 分/词，上限 24。 */
const EMOTION_STRONG_RE = /喜欢|想念|想你|舍不得|难过|委屈|哭|心疼|感动|害怕|孤单|抱歉|对不起|谢谢|抱抱|亲亲|陪伴|永远|最爱|在乎|重要|开心|太好了/g

const EMOTION_MEDIUM_RE = /有点|挺|蛮|累了|困|饿|烦|郁闷|害羞|生气|讨厌|紧张|激动|惊讶|意外|终于|还好/g

// ↑ 这两个是数出现次数（match），必须要 g；下面三个只判断「有没有」（test），绝不能带 g。
/** 约定 / 承诺：这类事忘了会出问题，所以加权。 */
export const PROMISE_RE = /答应|约定|说好|以后|下次|记得|不要忘|别忘了|发誓|保证|我会|明天|后天|下周/

/** 矛盾 / 道歉 / 和好：情绪浓度高，值得记住。 */
export const CONFLICT_RE = /吵架|生气|道歉|对不起|和好|误会|不理你|冷战|凶你|原谅|抱歉/

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
export const SELF_RE = /我(?:喜欢|讨厌|想要|是|会|在|叫|住|学|做|用|习惯|觉得|认为)|我的|我不|我觉|我准备|我打算|我计划|目标是|专业是|想当|在做|正在做|习惯用|平时用|常用/i

/** 长期事实类信号：命中就进 self 标签，享受「永不遗忘」保护。 */
export const FACT_RE = /目标是|专业是|想当|在做|正在做|习惯用|平时用|常用|我(?:喜欢|讨厌|习惯|住|学|专业)|我的(?:目标|专业|习惯|电脑)|大学|学院|专业|年级|大[一二三四]|研究生|在读|就读/i


/**
 * 一次性流水账：吃了什么、穿了几件、几点到哪、天气冷热……
 *
 * 为什么要单独拦它（2026-10-29 实测发现的坑）：
 * 「主人私下说的」原本直接 +42，而入选阈值就是 42 —— 等于只要是主人说的、
 * 超过 8 个字就必定入库。结果是记忆卡里躺着的五条全是「晚饭是牛肉丸子汤」
 * 「多穿了点衣服」，真正该留的画像反而被挤在后面。
 * 这类话每一天都在发生，记下来没有复用的价值。
 */
export const EPHEMERAL_RE = /吃(?:了|饭|完|过)|(?:早|午|晚|夜)饭|喝(?:了|完)|(?:多|少)穿|穿(?:了|上|着)|天气|气温|(?:不|很|挺|有点)(?:冷|热)|宿舍|寝室|起床|睡了|睡觉|出门|在路上|下课|放学|洗澡|洗漱|刷牙|几点了/


/** 「第一次」类事件：天然是锚点。 */
export const FIRST_RE = /第一次|初次|头一次|最开始|刚认识|认识你|纪念日|第一天|从来没有过/


/** 脱敏规则：入库前把明显的敏感信息抹掉。 */
const REDACT_RULES = [
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, '[密钥]'],
  [/\b([A-Za-z0-9_-]{24,})\b(?=[^\n]{0,20}(?:token|key|secret))/gi, '[令牌]'],
  [/\b1[3-9]\d{9}\b/g, '[手机号]'],
  [/\b\d{17}[\dXx]\b/g, '[身份证]'],
  // 卡号不走这张表：见 luhnLike 的注释（KNOWN-ISSUES #15）
  // QQ 号：桥接消息的前缀里带（「（QQ 私聊·用户本人 QQ 3472302240）」），
  // 不脱敏的话账号会原样写进记忆卡，再随注入发出去。
  [/QQ[:：\s]*(\d{5,12})/gi, '[QQ号]'],
  [/https?:\/\/[^\s，。；、）)]+/g, '[链接]']
]

/**
 * 卡号判定（2026-11-09 修 KNOWN-ISSUES #15）：原来 `\b\d{16,19}\b` 见长数字就抹，
 * 订单号 / 工单号 / 雪花 ID 被无差别毁掉，而且这是入库前的一次性变换，不可恢复。
 *
 * 产品取舍（两难：漏抹真卡号进长期记忆 vs 误抹订单号不可恢复）：
 * 用 **Luhn 校验 + 发卡组织前缀（3/4/5/6 开头）** 双重判 —— 主流发卡组织
 * （Visa/Mastercard/Amex/银联/JCB/Discover）的卡号全部通过 Luhn，误抹率从
 * 「任意 16–19 位数字」降到「3-6 开头且过 Luhn」，纯随机的长订单号命中概率
 * 约 4/10 × 1/10 ≈ 1/25。真卡号漏抹的风险：几乎为零（Luhn 是发卡强制算法）。
 * 若正文明确说「卡/卡号/银行卡」等上下文词，仍无条件抹（兜住非 Luhn 的罕见卡）。
 */
function luhnLike(digits) {
  let sum = 0
  let dbl = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48
    if (dbl) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}

const CARD_CONTEXT_RE = /(?:银行卡|储蓄卡|信用卡|卡号|尾号|刷卡|银行卡号)\s*[:：]?\s*$/


export const clamp = (value, min, max) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return min
  return Math.min(max, Math.max(min, num))
}


export function iso(now = Date.now()) {
  return new Date(now).toISOString()
}


export function timeOf(value, fallback = 0) {
  const num = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  return Number.isFinite(num) ? num : fallback
}


export function dateKey(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}


/** 入库前脱敏。宁可少记一条细节，也不要把密钥写进长期记忆。 */
export function redact(text, maxChars = 600) {
  let out = String(text ?? '')
  // 卡号单独判（在其它规则之前，免得后面的规则先改动数字周围的文本）：
  // 过 Luhn 且 3-6 开头 → 抹；不过但前面紧挨着「卡号/银行卡」等上下文词 → 也抹。
  out = out.replace(/\b(\d{16,19})\b/g, (m, digits, offset, full) => {
    if (/^[3-6]/.test(digits) && luhnLike(digits)) return '[卡号]'
    const before = full.slice(Math.max(0, offset - 8), offset)
    if (CARD_CONTEXT_RE.test(before)) return '[卡号]'
    return m
  })
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
