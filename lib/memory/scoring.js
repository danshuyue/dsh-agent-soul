/**
 * 记忆引擎 · scoring.js
 * 由 lib/memory.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { CONFLICT_RE, EPHEMERAL_RE, FACT_RE, FIRST_RE, PROMISE_RE, SELF_RE, clamp, emotionScore, timeOf } from './signals.js'
import { DAY_MS } from './constants.js'
import { normalizeConfig } from './config.js'


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
  // 2026-11-06 审计 P0-4：「手动指定重要度」必须真的是个数字。
  //
  // 原来写的是 `Number.isFinite(Number(input.importance))`，而
  //   Number(null) === 0、Number('') === 0、Number(false) === 0、Number([]) === 0
  // 全都是有限数 —— 于是调用方「没指定」（null / 空串）会把前面所有加分**整段作废**，
  // 记忆以 0 分落盘，紧接着被压缩和排序挤掉。实测：同一句话不传是 24 分，传 null 是 0 分。
  //
  // 现在只认 number 类型的有限数；字符串只在「非空」时按数字解析（配置文件里可能写成 "63"）。
  if (typeof input.importance === 'number' && Number.isFinite(input.importance)) {
    importance = input.importance
    reasons.push('手动指定')
  } else if (typeof input.importance === 'string' && input.importance.trim() !== '') {
    const parsed = Number(input.importance)
    if (Number.isFinite(parsed)) {
      importance = parsed
      reasons.push('手动指定')
    }
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
export function ownerImportant(record, cfg) {
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
