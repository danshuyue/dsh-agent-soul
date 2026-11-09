/**
 * evidence.js —— 开关的「生效 / 未生效」证据（2026-11-10 R18-C）。
 *
 * ── 为什么要它 ──
 *   语气链失效三天，日志一句错都没有，测试全绿。根因：**开关的值 ≠ 开关的效果** ——
 *   `moodToneInject: true` 只说明「用户没关它」，说明不了「它这一轮真的挂了语气」。
 *   同类事故还有：记忆卡一次都没创建、日志里连报错都没有（extract.js:179 记过）。
 *
 *   本模块提供两只眼睛：
 *   ① mark(key, note) —— 动态证据：这个开关**上次真的发生**是什么时候、发生了几次。
 *      内存 Map，不落盘（写盘会带来「统计本身就是新的失败面」）。
 *   ② statuses(cfg, extra) —— 静态生效性：这个配置组合下开关**可能**生效吗？
 *      inert（不可能生效）时必须给出**人话原因**（「心情关了」，而不是 moodEnabled=false）。
 *
 * ── 噪音纪律 ──
 *   启动打一行（index.js）+ 每日健康行带一句（health.js），**绝不每轮打** ——
 *   噪音会让人不再看日志，「哪一轮全掉了」就被淹掉了。
 *
 * ── 「0 次」≠「N/A」──
 *   report() 里区分「从未发生」（开关可能生效但还没轮到它）与
 *   「未生效：原因」（配置组合下不可能发生）。两者混报是这轮要消灭的假旋钮。
 */
import { exists, diaryPublicPath } from './paths.js'
import { yesterdayKey } from './diary/completion.js'

/** key → { count, lastAt, note }。全进程共享（开关证据本来就不分会话）。 */
const marks = new Map()

/**
 * 记一次「真的发生了」。由各链路的**送达点**调用（不是决策点）：
 *   · moodTone    —— 语气消息真的 append 进了她的 inbox（inject.js）
 *   · moodJudge   —— 心情判定成功写回（mood/judge.js）
 *   · memory      —— 记忆段真的注入了非空文本（segment-memory.js）
 *   · memoryRefine—— 提炼结果真的被接受入库（refine.js）
 * @param {string} key
 * @param {string} [note] 人话备注（进 report，截 40 字）
 */
export function mark(key, note = '') {
  const prev = marks.get(key)
  marks.set(key, {
    count: (prev?.count ?? 0) + 1,
    lastAt: Date.now(),
    note: String(note ?? '').slice(0, 40)
  })
}

/** 测试与 /state 用：只读快照。 */
export function markSnapshot() {
  return [...marks.entries()].map(([key, v]) => ({ key, count: v.count, lastAt: v.lastAt, note: v.note }))
}

/** 测试用：清空（正常流程永不调）。 */
export function __resetEvidenceForTest() {
  marks.clear()
}

/**
 * 单个开关的动态证据怎么写。
 * @returns {string} ''（没有 mark 点的开关）| '0 次' | 'N 次'
 */
function evidenceOf(key) {
  const m = marks.get(key)
  if (m === undefined) return ''
  return `${m.count} 次`
}

/**
 * 全部开关的静态生效性 + 动态证据。
 *
 * @param {object} cfg loadConfig() 的结果
 * @param {{ memoryRecords?: number, notesCount?: number }} [extra] 调用方算好的数据面
 * @returns {Array<{key:string, label:string, status:'生效'|'未生效'|'暂无'|'从未发生'|'生效(N次)'|'边界', reason:string}>}
 */
export function statuses(cfg, extra = {}) {
  const out = []
  const push = (key, label, status, reason = '') => out.push({ key, label, status, reason })
  const on = (v) => v !== false
  const memoryRecords = Number(extra.memoryRecords)
  const notesCount = Number(extra.notesCount)

  // ---- 总开关 ----
  if (on(cfg.enabled)) push('enabled', '总开关', '生效')
  else {
    push('enabled', '总开关', '未生效', '插件总开关关了——下面的全部跟着停')
    push('memoryEnabled', '记忆', '未生效', '插件总开关关了')
    push('purposeEnabled', '目的', '未生效', '插件总开关关了')
    push('notesEnabled', '笔记', '未生效', '插件总开关关了')
    push('moodEnabled', '心情', '未生效', '插件总开关关了')
    push('moodToneInject', '心情语气', '未生效', '插件总开关关了')
    push('diaryEnabled', '日记', '未生效', '插件总开关关了')
    push('memoryRefine', '提炼', '未生效', '插件总开关关了')
    push('projectMemoryEnabled', '项目记忆', '未生效', '插件总开关关了')
    push('projectPersonaEnabled', '项目人格', '未生效', '插件总开关关了')
    return out
  }

  // ---- 记忆 ----
  if (on(cfg.memoryEnabled)) {
    if (Number.isFinite(memoryRecords) && memoryRecords === 0) push('memoryEnabled', '记忆', '暂无', '还没有一条记忆（聊出值得记的事才会有）')
    else push('memoryEnabled', '记忆', '生效', Number.isFinite(memoryRecords) ? `${memoryRecords} 条` : '')
  } else push('memoryEnabled', '记忆', '未生效', '记忆关了（素材照常收集，只是不注入不提取）')

  // ---- 提炼（最贵，出过静默降级）----
  if (on(cfg.memoryRefine)) {
    const n = evidenceOf('memoryRefine')
    if (n === '') push('memoryRefine', '提炼', '从未发生', '开关开着，但还没有一次提炼发生（等下一条入库；没配提炼模型会一直停在这）')
    else push('memoryRefine', '提炼', `生效(${n})`)
  } else push('memoryRefine', '提炼', '未生效', '提炼关了——记忆直存原话')

  // ---- 目的 ----
  push('purposeEnabled', on(cfg.purposeEnabled) ? '目的' : '目的', on(cfg.purposeEnabled) ? '生效' : '未生效', on(cfg.purposeEnabled) ? '' : '目的关了')

  // ---- 笔记 ----
  if (on(cfg.notesEnabled)) {
    if (Number.isFinite(notesCount) && notesCount === 0) push('notesEnabled', '笔记', '暂无', '笔记目录是空的（她还没写过一篇）')
    else push('notesEnabled', '笔记', '生效', Number.isFinite(notesCount) ? `${notesCount} 篇` : '')
  } else push('notesEnabled', '笔记', '未生效', '笔记关了')

  // ---- 心情 + 语气（出过三天静默事故的那条链）----
  if (on(cfg.moodEnabled)) {
    const judge = evidenceOf('moodJudge')
    push('moodEnabled', '心情', judge === '' ? '从未发生' : `生效(判定 ${judge})`, judge === '' ? '开关开着，但还没有一次判定发生（等第一轮对话结束）' : '')
    if (on(cfg.moodToneInject)) {
      const tone = evidenceOf('moodTone')
      if (tone === '') push('moodToneInject', '心情语气', '从未发生', '开关开着，但还没有一次语气真的挂出去（要等判定成功 + 轮次节流到点）')
      else push('moodToneInject', '心情语气', `生效(挂 ${tone})`)
    } else push('moodToneInject', '心情语气', '未生效', '语气开关关了——心情照样判，只是不往对话里挂')
  } else {
    push('moodEnabled', '心情', '未生效', '心情关了')
    push('moodToneInject', '心情语气', '未生效', '心情关了——判定不跑，语气无从挂起')
  }

  // ---- 日记 ----
  if (on(cfg.diaryEnabled)) {
    const yesterdayWritten = exists(diaryPublicPath(yesterdayKey(Date.now())))
    push('diaryEnabled', '日记', yesterdayWritten ? '生效' : '从未发生', yesterdayWritten ? '昨天的已写' : '昨天的还没写（看门狗/兜底会来补）')
  } else push('diaryEnabled', '日记', '未生效', '日记关了')

  // ---- 其余开关（静态，无 mark 点）----
  push('projectMemoryEnabled', on(cfg.projectMemoryEnabled) ? '项目记忆' : '项目记忆', on(cfg.projectMemoryEnabled) ? '生效' : '未生效', on(cfg.projectMemoryEnabled) ? '' : '项目记忆关了（只记全局一张卡）')
  push('projectPersonaEnabled', on(cfg.projectPersonaEnabled) ? '项目人格' : '项目人格', on(cfg.projectPersonaEnabled) ? '生效' : '未生效', on(cfg.projectPersonaEnabled) ? '' : '项目人格关了（只吃全局人格）')
  push('includeGlobal', on(cfg.includeGlobal) ? '全局人格' : '全局人格', on(cfg.includeGlobal) ? '生效' : '未生效', on(cfg.includeGlobal) ? '' : '关了 =「纯项目制」，没有项目人格的会话将没有人格')
  push('memoryRecentDiaryIncludePrivate', '最近日记含私密', on(cfg.memoryRecentDiaryIncludePrivate) ? '生效' : '未生效', on(cfg.memoryRecentDiaryIncludePrivate) ? '' : '关了 =「最近」段只带公开日记')
  push('diaryCatchUp', '日记追补', on(cfg.diaryCatchUp) ? '生效' : '未生效', on(cfg.diaryCatchUp) ? '' : '关了 = 错过的日子不往前补')
  push('diaryOverwrite', '日记重写', on(cfg.diaryOverwrite) ? '生效' : '未生效', on(cfg.diaryOverwrite) ? '' : '关了 = 已存在的日记不覆盖')
  push('diaryAgentWrite', '先投给她写', on(cfg.diaryAgentWrite) ? '生效' : '未生效', on(cfg.diaryAgentWrite) ? '' : '关了 = 跳过「让她自己写」，直接兜底生成')
  push('diaryManualNote', '手动触发带备注', on(cfg.diaryManualNote) ? '生效' : '未生效', on(cfg.diaryManualNote) ? '' : '关了 = 手动触发不接受备注')
  push('apiLoopbackOnly', '仅本机访问', cfg.apiLoopbackOnly === false ? '边界' : '边界', cfg.apiLoopbackOnly === false ? '⚠ 已放宽（需启动环境 DSH_SOUL_ALLOW_REMOTE_API=1）——确认是你自己干的' : '设置页接口只允许本机回环')

  return out
}

/**
 * 一行人话总览（启动 + 每日健康行用）。
 * @returns {string}
 */
export function reportLine(cfg, extra = {}) {
  const rows = statuses(cfg, extra)
  const mark = (row) => row.status === '未生效' ? '✗' : row.status === '暂无' || row.status === '从未发生' ? '◐' : '✓'
  const okPart = rows.filter((r) => mark(r) === '✓').map((r) => `${r.label}${r.reason !== '' && !r.label.includes('开关') ? `(${r.reason})` : ''}✓`)
  const pendingPart = rows.filter((r) => mark(r) === '◐').map((r) => `${r.label}◐(${r.reason})`)
  const offPart = rows.filter((r) => r.status === '未生效').map((r) => `${r.label}✗(${r.reason})`)
  const parts = []
  if (okPart.length > 0) parts.push(`生效：${okPart.join(' ')}`)
  if (pendingPart.length > 0) parts.push(`暂未发生：${pendingPart.join(' ')}`)
  if (offPart.length > 0) parts.push(`未生效：${offPart.join(' ')}`)
  return `开关证据｜${parts.join(' ｜ ')}`
}
