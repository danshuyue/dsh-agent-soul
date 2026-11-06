/**
 * 宿主装配 · refine.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { addRecord, classifyScope } from '../../memory.js'
import { commitIngestBatch, failIngestBatch, ingestCandidates } from '../../extract.js'
import { createHash } from 'node:crypto'
import { globalCard, projectCard, saveGlobalCard, saveProjectCard, writeAutoMemories } from '../../store.js'
import { markRefineQueued, markRefineSettled } from '../../health.js'
import { note, noteThrottled } from '../../env.js'
import { refineCandidates } from '../../refine.js'



/**
 * 保险：没设 ownerName 时提醒一次（2026-11-04）。
 *
 * 为什么需要：主人名字默认空串之后，提示词里所有「关于谁」的句子都会整句省略 ——
 * 这是**对的**（不能留「你是 的伴侣」这种空壳），但它同时是静默的：
 * 用户只会觉得「她好像不认识我了」，完全看不出差一个设置。
 * 所以每小时在 soul.log 里留一行，说清「哪个段落被跳过了、去哪里填」。
 *
 * 只写日志、不影响任何功能：记忆、笔记、日记都不读 ownerName，照常工作。
 * againAt 给一个大值 = 每个小时只记第一次，不按次数加码。
 */
export function noteMissingOwner(cfg) {
  if (String(cfg?.ownerName ?? '').trim() !== '') return false
  return noteThrottled(
    'persona',
    'owner-name-missing',
    '未设置 ownerName：提示词里「关于谁」的段落（关系 / 性别 / 称呼那句）已跳过，请在设置页「主人是谁」里填写。记忆、笔记、日记不受影响。',
    { againAt: 9999 }
  )
}



/** 提炼链：一次只跑一批，避免两批候选同时改同一张卡。 */
let refineChain = Promise.resolve()



/**
 * 提炼失败的日志节流（2026-11-04，B3 配套；③ 改成共用实现）。
 *
 * 为什么要分频：提炼失败有两种完全不同的成因 ——
 *   · 偶发：一次超时、一次格式异常。逐条记日志正好，能定位。
 *   · 系统性：密钥过期、模型下线、余额不足。这时每条候选都会失败，
 *     逐条记会把 soul.log 刷成噪音，真正重要的那行（第一次）反而被埋掉。
 * 所以：每小时只在第 1 次记完整原因，第 5 次补一句「这是系统性失败」，
 * 之后静默到下一个小时。日志是线索，不是流水账。
 *
 * 2026-11-04 修 ③：这套分频原来只在这里，refine.js 的两处失败日志没覆盖到，
 * 所以抽成 env.js 的 noteThrottled，三处（这里 + refine 的调用失败 + 解析失败）
 * 统一调用 —— 一处实现，口径不会再漂。
 */
function noteRefineFailure(message) {
  noteThrottled('memory', 'refine', `提炼失败：${message}`, {
    againAt: 5,
    againMessage: '提炼本小时已连续失败 5 次 —— 这不像偶发（可能是密钥/余额/模型下线），之后不再逐条记'
  })
}



/**
 * 把候选交给模型提炼，再落盘（异步）。
 *
 * 为什么不 await：tick 跑在 systemPrompt.context 的 text() 里，是**同步**的、
 * 每回合都要走一遍的路。等一次 30 秒的模型调用 = 每轮对话都卡 30 秒。
 * 所以排队后台跑：这一轮注入用旧卡，下一轮就看得到新记忆。
 * 提炼失败（超时 / 报错 / 格式崩）一律退回原话直存 —— 宁可记糙，不能把信息丢掉。
 *
 * 2026-11-04 修 ①：**落盘成功之后才推进游标**（batch 由 collectCandidates 带过来）。
 * 以前 collectCandidates 在返回前就把游标推到 to+1，这里写盘失败只记一行日志 ——
 * 那一批对话既没进卡，下一轮也不会再扫，永久消失。现在三条出口都过 settle：
 *   · 写成功 → commitIngestBatch（推进 + 清失败计数）
 *   · 写失败 → failIngestBatch（不推进，下一轮重试；连续 3 次才放弃并推进）
 *   · 没东西要写（提炼结果为空）→ 也算成功，直接推进
 *
 * @param {{key: string, to: number}|null} batch 这一批对应的扫描窗口
 */
export function queueRefine(agent, cwd, candidates, config, llm, batch) {
  // 在途 +1（出队时 -1）。健康行读的是这个数 —— Promise 链本身没有长度。
  markRefineQueued()
  refineChain = refineChain
    .then(async () => {
      const settle = (ok) => {
        if (ok === true) commitIngestBatch(batch)
        else failIngestBatch(batch, '记忆没写进磁盘')
      }

      // 2026-11-04 修 B3：**抛异常也要降级**。
      //
      // 原来只有 `refined === null` 这一条路会退回 ingestRaw；如果 refineCandidates
      // 自己抛（网络断、JSON 解析崩、response 形状不对），异常会一路飞到外层 .catch，
      // 那里只记一行日志 —— 而当时 collectCandidates 早就把游标推过去了，
      // 于是这批候选永久消失：既没进卡，下一轮也不会再扫。
      //
      // 降级落卡是安全的：ingestCandidates 里还有两道闸（autoMemoryRejectReason、
      // minImportanceForKind），而且带人物属性的原话会被升成 fact（门槛 70→42），
      // 关于主人的信息反而比走提炼更容易留下。
      let refined = null
      try {
        refined = await refineCandidates(llm, agent, candidates, {
          // 2026-11-04：主人名字走 ownerName，不再回落到写死的「树树」。
          // 空串时 refine.js 用中性的「对方」—— 提炼的是记忆，不该因为没设名字就停。
          owner: String(config.ownerName || ''),
          provider: String(config.memoryRefineProvider || ''),
          model: String(config.memoryRefineModel || '')
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        noteRefineFailure(`${reason}（候选 ${candidates.length} 条，已退回原话直存）`)
        settle(ingestRaw(cwd, candidates, config))
        return
      }

      if (refined === null) {
        noteRefineFailure(`${candidates.length} 条候选退回原话直存`)
        settle(ingestRaw(cwd, candidates, config))
        return
      }
      if (refined.length === 0) {
        // 2026-11-05 S2 / P1-5：这里原来把前 5 条候选原话各截 40 字写进日志，
        // 日志轮转还留 5 份 —— 等于「遗忘」之后原文仍在磁盘上躺很久。
        // 改为只记条数 + 长度 + 8 位哈希：仍能核对「这批是不是同一批」，
        // 但不把对话内容留下。想看原文请用记忆卡/对话 JSONL 的受控入口。
        const preview = candidates
          .slice(0, 5)
          .map((c) => {
            const text = String(c?.text ?? c?.content ?? c ?? '').replace(/\s+/g, ' ').trim()
            if (text === '') return '（空）'
            const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)
            return `${text.length}字#${hash}`
          })
          .join(' ｜ ')
        note('memory', `候选 ${candidates.length} 条，没提炼出值得记的（寒暄/废话）。仅记指纹：${preview || '（空）'}；原文不落日志`)
        // 这一批本来就没有要写的东西 —— 写成功，推进游标，别每轮重扫
        commitIngestBatch(batch)
        return
      }
      const report = writeAutoMemories(cwd, refined, config)
      if (report.written > 0) {
        note('memory', `提炼出 ${report.written} 条记忆（候选 ${candidates.length}）${Array.isArray(report.scopes) && report.scopes.length > 0 ? `，去向：${report.scopes.join(' + ')}` : ''}`)
      }
      // 2026-11-04 修 ①：writeAutoMemories 现在会带 saved=false 回来。
      // 这行是主路（有模型时默认走提炼），不看它的话失败照样静默丢数据。
      if (report.written > 0 && report.saved === false) {
        failIngestBatch(batch, '提炼结果写盘失败')
        return
      }
      commitIngestBatch(batch)
    })
    .catch((error) => {
      // 走到这里说明上面的降级路径自己出了问题（比如 ingestRaw 抛了）。
      // 候选这时确实救不回来了，但至少把原因留下 —— 而且链必须接住，
      // 否则 refineChain 变成 rejected，之后所有提炼任务都会被跳过（直到重启）。
      note('memory', `提炼链异常（降级路径也没能兜住）：${error instanceof Error ? error.message : error}`)
      // 兜底也要结账：不结的话这个会话会一直挡在 inflight 状态上，
      // 直到 15 分钟后才被当作「丢了」重扫；失败计数也记不上，放弃条件永远不会触发。
      failIngestBatch(batch, '提炼链异常')
    })
    // 出队 -1：成功、降级、异常都算「这一批结束了」。
    // 放在 finally 而不是每条 return 前，是怕以后新增出口又忘了结账。
    .finally(() => markRefineSettled())
}



/**
 * 老的直存路径：候选原话直接进卡（不提炼）。
 *
 * 只在「没有模型服务」或「配置里关了提炼」时走 —— 也是提炼失败时的兜底。
 * 自动记进**项目卡**（有 cwd 时），否则全局卡：跟随当前工作上下文，避免跨项目污染。
 *
 * @returns {boolean} 内存里算出来的东西**真的写进磁盘了**吗
 *   2026-11-04 修 ①：saveProjectCard/saveGlobalCard 的返回值现在必须看 ——
 *   以前完全不看，调用方也早就把游标推过去了，写盘失败那批对话就永久消失。
 *   false 时调用方不推进游标，下一轮从同一段重扫补上。
 */
export function ingestRaw(cwd, candidates, config) {
  const useProject = String(cwd ?? '').trim() !== '' && config.projectMemoryEnabled !== false
  // 2026-11-05：先判归属再写，不再「先全写项目卡、再把重要的抄进全局」。
  // 双写会让项目卡变成全局卡的副本，同一条还可能在注入里出现两遍。
  const projectCands = []
  const globalCands = []
  for (const candidate of candidates) {
    const scope = useProject ? classifyScope(candidate?.text, cwd, config) : 'global'
    if (scope === 'project') projectCands.push(candidate)
    else globalCands.push(candidate)
  }

  let savedOk = true
  if (projectCands.length > 0) {
    const pcard = projectCard(cwd)
    const written = ingestCandidates(pcard, addRecord, projectCands, config, Date.now())
    if (written > 0 && saveProjectCard(cwd, pcard)?.ok !== true) savedOk = false
  }
  if (globalCands.length > 0) {
    const gcard = globalCard()
    const written = ingestCandidates(gcard, addRecord, globalCands, config, Date.now())
    if (written > 0 && saveGlobalCard(gcard)?.ok !== true) savedOk = false
  }
  return savedOk
}
