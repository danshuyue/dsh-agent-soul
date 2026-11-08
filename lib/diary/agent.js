/**
 * 日记 · agent.js（2026-11-10 KNOWN-ISSUES #27：由 compose.js 按职责拆出）
 * 会话 preset 组装修复：composeDiarySetup。函数体逐字未改。
 * 它全是「宿主服务交互」（agentPresets / sessions / 落盘日志），与 compose 的
 * 「拼 prompt」无关 —— 上一轮拆分时留错了地方，本轮按 HANDOFF #27 的建议移正。
 * 另：原文件里还有两段 diaryAgent 的孤儿 docblock（函数本体 2026-11-06 已迁到
 * scheduler.js），本轮一并删除。
 */
import { note, serviceOf } from '../env.js'
import { loadConfig } from '../store.js'
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

/**
 * 取绑定好的日记会话（2026-10-31：从「自建会话」改成「绑定已有会话」；2026-11-03 补冷启动 preset；
 * 2026-11-05 补 agentOptions.model）。2026-11-10 #26 由 scheduler.js 并入本模块 ——
 * 「会话获取/冷启动」与 composeDiarySetup 本来就是同一件事的两半。
 * 完整的事故推理链见原 scheduler.js 版本（git 历史）与本函数体内注释。
 */
export async function diaryAgent(ctx) {
  const config = loadConfig()
  const sessionId = String(config.diarySessionId ?? '').trim()

  if (sessionId === '') {
    // 没有绑定就是没有绑定。以前这里会去捞「最近活跃会话」，等于把日记写进
    // 用户正在聊的那个会话 —— 语义错了，私密内容还可能摆到不该看的人面前。
    note('diary', '没有绑定日记会话（diarySessionId 为空），跳过本次投递。去设置页「日记」里点「把当前会话指定为日记会话」')
    return undefined
  }

  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    note('diary', `绑定的日记会话不可用：宿主没有 agents 服务（${sessionId}）`)
    return undefined
  }

  const reasons = []

  // ① 活着的
  try {
    const live = agents.get(sessionId)
    if (live !== undefined && live !== null) {
      note('diary', `绑定的日记会话已在运行：${sessionId}`)
      return live
    }
    reasons.push('当前不活跃')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note('diary', `取活会话 ${sessionId} 失败：${message}`)
    reasons.push(`get 失败：${message}`)
  }

  // ② 冷启动
  if (typeof agents.resume !== 'function') {
    reasons.push('agents 服务没有 resume 方法')
  } else {
    try {
      // 必须带上 setup：resume 只恢复会话，不恢复 preset。
      // 不带的话日记会话会「活着但没有工具」，而且不报错（2026-11-03 事故）。
      const setup = await composeDiarySetup(ctx, sessionId)

      // 2026-11-05 修：还必须有 agentOptions.model。
      //
      // 文档原话：「agents[].provider / agents[].model —— 模型路由；分发前两者都必须存在」。
      // resume 一个持久化会话时，模型**不会**从会话里恢复（session 头里根本没这个字段），
      // 不显式传就得到一个没有模型的 agent。后果不是「模型选错了」，而是装配直接抛：
      //   prompt variable "{{model}}" has no value (section "deployment:persona-prefix")
      // 每一轮都抛，日记一个字也写不出来 —— 而且界面只显示「本轮运行失败」，很难联想到模型。
      //
      // 路由取日记专用配置；没配就退回 diarySummarize*（也是给日记用的），
      // 两个都没有时明确记一行，不要静默传空。
      const provider = String(config.diaryAgentProvider ?? '').trim() || String(config.diarySummarizeProvider ?? '').trim()
      const model = String(config.diaryAgentModel ?? '').trim() || String(config.diarySummarizeModel ?? '').trim()
      let agentOptions
      if (provider !== '' && model !== '') {
        agentOptions = { provider, model }
      } else {
        note('diary', '没配 diaryAgentProvider/Model 也没配 diarySummarize*：冷启动的日记会话将没有模型，装配会失败')
      }

      const handle = await agents.resume({
        resumeSessionId: sessionId,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(setup === undefined ? {} : { setup })
      })
      const agent = handle?.agent
      if (agent !== undefined && agent !== null) {
        note('diary', `冷启动绑定的日记会话成功：${sessionId}`)
        return agent
      }
      reasons.push('resume 没有返回 agent')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      note('diary', `冷启动绑定的日记会话 ${sessionId} 失败：${message}`)
      reasons.push(`resume 失败：${message}`)
    }
  }

  note('diary', `绑定的日记会话不可用：${reasons.join('；') || '未知原因'}（${sessionId}）`)
  return undefined
}
