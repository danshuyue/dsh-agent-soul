/**
 * 日记 · agent.js（2026-11-10 KNOWN-ISSUES #27：由 compose.js 按职责拆出）
 * 会话 preset 组装修复：composeDiarySetup。函数体逐字未改。
 * 它全是「宿主服务交互」（agentPresets / sessions / 落盘日志），与 compose 的
 * 「拼 prompt」无关 —— 上一轮拆分时留错了地方，本轮按 HANDOFF #27 的建议移正。
 * 另：原文件里还有两段 diaryAgent 的孤儿 docblock（函数本体 2026-11-06 已迁到
 * scheduler.js），本轮一并删除。
 */
import { note, serviceOf } from '../env.js'
import { readSessionMeta } from '../session-title.js'


/**
 * 按会话记录里的 preset 组装 setup（2026-11-03）。
 *
 * ── 为什么需要它 ──
 *   `agents.resume` 只恢复会话，**不会自动把 preset 挂回来**。
 *   不传 setup 冷启动出来的 agent 没有 preset，工具只剩全局插件那一层：
 *   qq_* / soul_* / screen_* / session_* 都在，但 read / write / glob / grep / pwsh /
 *   job_* / subagent 全没了。现象是「日记会话突然干不了活」，而且不会报错。
 *
 *   那次事故的现场（2026-11-03 早上）：这个会话第 76 轮还有 57 个工具，
 *   第 83 轮掉到 27 个，掉掉的正好是 preset 里的那 30 个。原因就是开机时
 *   日记会话没开着，走了这条冷启动路径，而那时它没带 setup。
 *
 * ── 做的事和 UI 打开会话时一致 ──
 *   resolve(presetId) 拿到预设，再 mount 到新 agent 的 ctx 上。
 *
 * @returns {Function|undefined} 可直接传给 agents.resume 的 setup；拿不到就等于没传
 */
export async function composeDiarySetup(ctx, sessionId) {
  const presets = serviceOf(ctx, 'agentPresets')
  const sessions = serviceOf(ctx, 'sessions')
  if (
    presets === undefined || presets === null ||
    typeof presets.resolve !== 'function' || typeof presets.mount !== 'function'
  ) {
    note('diary', 'agentPresets 服务不可用：冷启动的日记会话将没有 preset（工具会缺一大批）')
    return undefined
  }

  let presetId
  try {
    const session = sessions !== undefined && sessions !== null && typeof sessions.get === 'function'
      ? sessions.get(sessionId)
      : undefined
    presetId = session?.header?.agentPreset
  } catch (error) {
    note('diary', `读日记会话的 preset 失败：${error instanceof Error ? error.message : error}`)
  }
  // 2026-11-05 修：会话不活跃时 sessions.get() 返回空，**不能因此认为它没有 preset**。
  // preset 一直在落盘日志第一行里（{"type":"session",...,"agentPreset":"standard"}）。
  // 读不到才真的没有 —— 那次线上事故就是这么来的：拿不到 preset 就没挂模型，
  // 每轮装配都报 prompt variable "{{model}}" has no value，日记一个字写不出来。
  if (typeof presetId !== 'string' || presetId === '') {
    const meta = readSessionMeta(sessionId)
    if (meta !== null && meta.agentPreset !== '') {
      presetId = meta.agentPreset
      note('diary', `日记会话不活跃，从落盘日志里读到 preset：${presetId}`)
    }
  }
  if (typeof presetId !== 'string' || presetId === '') {
    note('diary', `日记会话 ${sessionId} 真的没有 agentPreset（live 和落盘都读不到），冷启动将不带 preset`)
    return undefined
  }

  try {
    const resolved = await presets.resolve(presetId)
    return async (agentCtx) => {
      await presets.mount(agentCtx, resolved.id)
    }
  } catch (error) {
    note('diary', `组装修复 setup 失败：${error instanceof Error ? error.message : error}`)
    return undefined
  }
}
