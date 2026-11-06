/**
 * 记忆引擎 · config.js
 * 由 lib/memory.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { DEFAULTS } from './constants.js'
import { clamp } from './signals.js'


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
  // 主人身份的归一（2026-11-04）：只认 male / female / 空串。
  // 写「男」「男生」这类值一律当没设 —— 提示词里用的是这个词本身，
  // 收下一个近义词只会让它跟着那句话一起漏进提示词，不如让那条整句省略。
  out.ownerGender = out.ownerGender === 'male' || out.ownerGender === 'female' ? out.ownerGender : ''
  // 名字 / 关系是自由文本，但要防住「全空白」和超长：前者等于没设，后者会撑爆提示词。
  out.ownerName = typeof out.ownerName === 'string' ? out.ownerName.trim().slice(0, 24) : ''
  out.relationship = typeof out.relationship === 'string' ? out.relationship.trim().slice(0, 24) : ''
  // 2026-11-05 修 P0-3：DEFAULTS 只有引擎要用的 20 个键，而 DEFAULT_CONFIG
  // 有 70 个。以前这里把其余 50 个键**全丢了**，于是 store.js 里读
  // cfg.projectMemoryEnabled / cfg.purposeEnabled / cfg.globalPromoteImportance
  // 恒为 undefined —— 「关掉项目记忆」「关掉目的机制」「双写门槛」静默失效，
  // 改了配置不生效也不报错。
  //
  // 为什么不把 50 个键抄进 DEFAULTS：那是第二份默认值表，迟早再次失同步。
  // 这里只做「安全透传」：类型收敛（NaN / 负数 / 超长）仍只对 DEFAULTS 的
  // 20 个引擎键做，其余键原样交给各自的消费方判断；危险键名和引用类型
  // 一律挡掉或浅拷贝，避免配置对象带进原型污染 / 共享引用。
  const blockedKeys = new Set(['__proto__', 'constructor', 'prototype'])
  for (const key of Object.keys(src)) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || blockedKeys.has(key)) continue
    const value = src[key]
    const type = typeof value
    if (type === 'boolean' || type === 'string' || (type === 'number' && Number.isFinite(value))) {
      out[key] = value
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 100)
    } else if (value !== null && type === 'object') {
      out[key] = { ...value }
    }
  }
  return out
}
