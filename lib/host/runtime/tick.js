/**
 * 宿主装配 · tick.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { MAINTAIN_INTERVAL_MS } from '../meta.js'
import { collectCandidates, commitIngestBatch, failIngestBatch, isSubagentSession } from '../../extract.js'
import { ingestRaw, queueRefine } from './refine.js'
import { maintain } from '../../store.js'
import { maintainClock } from './state.js'
import { note } from '../../env.js'



/** 注入时的轻量维护：衰减/压缩按自己的节奏，提取每回合都做（增量，很便宜）。 */
export function tick(agent, cwd, config, { allowMaintain = true, llm = null } = {}) {
  // 子会话整段跳过：不维护、不提取、不写日记。
  // 这是「会不会产生写入」的唯一收敛点 —— 判断只写在这里，别在调用方散写。
  if (isSubagentSession(agent)) return
  const now = Date.now()
  // 维护时段（2026-11-04 接上 dailyHour）：
  //   dailyHour = 0 → 不限制，还是「每 10 分钟」那套（默认，保持原行为）
  //   dailyHour > 0 → 当天过了这个点才跑，且**一天只跑一次**
  const dailyHour = Math.max(0, Math.min(23, Math.trunc(Number(config.dailyHour) || 0)))
  let maintainAllowed = allowMaintain && now - maintainClock.at > MAINTAIN_INTERVAL_MS
  if (maintainAllowed && dailyHour > 0) {
    const d = new Date(now)
    const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    if (d.getHours() < dailyHour || maintainClock.day === dayKey) maintainAllowed = false
    else maintainClock.day = dayKey
  }
  if (maintainAllowed) {
    maintainClock.at = now
    try {
      const report = maintain(cwd, config)
      if (report.decayed.length > 0 || report.compacted.length > 0) {
        note('tick', `维护完成：衰减 ${report.decayed.join('/') || '无'}，压缩 ${report.compacted.length} 处`)
      }
      // 2026-11-05 修 P0-4：写盘失败别再让日志一片祥和，至少留一行可查。
      if (Array.isArray(report.errors) && report.errors.length > 0) {
        note('tick', `维护写盘失败 ${report.errors.length} 处：${report.errors.map((item) => `${item.scope}/${item.stage}`).join('、')}`)
      }
    } catch (error) {
      note('tick', `维护失败：${error instanceof Error ? error.message : error}`)
    }
  }

  if (agent === undefined || agent === null) return
  let batch = null
  try {
    const collected = collectCandidates(agent, { limit: config.maxPerTick ?? 12 })
    batch = collected.batch
    const candidates = collected.candidates
    if (candidates.length === 0) return
    // 有模型就走「提炼成记忆」；没有模型 / 关掉了就退回原话直存（老路径，不丢信息）
    if (llm !== null && llm !== undefined && config.memoryRefine !== false) {
      // 游标由 queueRefine 在落盘之后结账（异步；这一轮不 await）
      queueRefine(agent, cwd, candidates, config, llm, batch)
    } else {
      // 2026-11-04 修 ①：落盘成功才推进游标；失败就不推，下一轮重试。
      if (ingestRaw(cwd, candidates, config) === true) commitIngestBatch(batch)
      else failIngestBatch(batch, '原话直存写盘失败')
    }
  } catch (error) {
    note('extract', `提取失败：${error instanceof Error ? error.message : error}`)
    // 已经拿到 batch 却在中途抛了：必须结账，否则这个会话会一直挡在 inflight 上
    // （最多挡 15 分钟），期间提取等于停摆。按失败记，下一轮重试。
    if (batch !== null) failIngestBatch(batch, '提取中途异常')
  }

  // 2026-11-04：collectForDiary 已经从 tick 里挪到 soul:memory 的 text() 里了。
  // 留在这里的话它会跟着记忆开关一起被挡住（见那边的注释）。
  // 挪出去之后 tick 只做「记忆自己的事」：维护 + 提取。
}
