/**
 * 状态与持久化编排 · render.js
 * 由 lib/store.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { DEFAULTS, normalizeConfig, renderCard, renderRecalledBlock, status } from '../memory.js'
import { globalCard, projectCard } from './cards.js'
import { join } from 'node:path'


/** 渲染给提示词的完整块（人格之外的记忆 + 目的）。 */
export function renderMemoryBlock(cwd, config = {}) {
  const cfg = normalizeConfig(config)
  if (cfg.enabled === false) return ''
  const parts = []
  const limit = Math.max(400, Math.trunc(Number(cfg.injectMaxChars) || DEFAULTS.injectMaxChars))
  // 项目卡优先分预算：它更贴近当前任务
  const project = String(cwd ?? '').trim() !== '' && cfg.projectMemoryEnabled !== false ? projectCard(cwd) : null
  const global = globalCard()
  const projectBudget = project !== null ? Math.floor(limit * 0.6) : 0
  const globalBudget = limit - projectBudget

  // 2026-11-05（A）：跨卡去重下沉到 renderCard 的 seen Set（跟 renderRecalledBlock 的 used 同一个口径）。
  // 先渲染全局卡，项目卡接在后面：撞上的条目在项目卡里跳过，所以全局卡是「正本」。
  // 之前那版是渲染前手工过滤全局卡，只能治两张卡之间，治不了同一张卡内部的重复。
  const seen = new Set()
  const textOf = (record) => String(record?.text ?? '').trim()
  // 项目卡有没有「全局卡里没有的」条目：有才需要它自己的脚注位置，没有就别把脚注吞掉。
  const globalTexts = new Set((global?.records ?? []).map(textOf).filter((text) => text !== ''))
  const projectAddsSomething = project !== null
    && (project.records ?? []).some((record) => !globalTexts.has(textOf(record)))

  // 顺序：全局卡的固定区（永远不会忘的）先出来，项目卡接在后面。
  // 反过来在实验里读起来像「先讲这个项目、再讲我是谁」，重点被压到第二屏去。
  const globalBlock = renderCard(global, { config: cfg, maxChars: globalBudget, omitFooter: projectAddsSomething, seen })
  if (globalBlock !== '') parts.push(globalBlock)
  if (project !== null) {
    const block = renderCard(project, {
      config: cfg,
      maxChars: projectBudget,
      omitHeader: parts.length > 0,
      titleSuffix: '（这个工作区）',
      seen
    })
    if (block !== '') parts.push(block)
  }
  // 引导她主动记：工具注册了不等于她会想到用。
  // 自动提取只能接住「说得够明确、信号够强」的那些，
  // 剩下「这句其实值得留」的判断，只有她自己在对话里才做得出。
  if (parts.length > 0) {
    parts.push('觉得该记住的，可以自己用 soul_memory 记下来；要分段、成一个主题的，用 soul_note 写成笔记。记错了都能删。')
  }
  return parts.join('\n\n')
}


/**
 * 按「当前这句用户消息」注入记忆（2026-10-30，P1）。
 *
 * 结构：固定区（开始 / 永远不会忘的，不裁剪）→ 相关区（按 query 召回 top-k）
 * → 兜底（还有余量就按分区顺序回填）。项目卡和全局卡一起打分、按 text 去重。
 *
 * 两条安全底线：
 *   ① memoryRecall=false 或 query 为空 → 原样调用 renderMemoryBlock，
 *      输出与改动前逐字节一致（旧路径没有第二份实现）。
 *   ② query 只来自 extract.currentUserText（当前用户消息），
 *      绝不拿注入块 / 工具结果 / time-context 拼 —— 那会把上下文自身当检索词，
 *      越召越偏，而且不可复现。
 */
export function renderMemoryBlockRecalled(cwd, config = {}, queryText = '') {
  const cfg = normalizeConfig(config)
  if (cfg.enabled === false) return ''
  const query = String(queryText ?? '').trim()
  if (query === '' || cfg.memoryRecall !== true) return renderMemoryBlock(cwd, cfg)

  const cards = []
  if (String(cwd ?? '').trim() !== '' && cfg.projectMemoryEnabled !== false) cards.push(projectCard(cwd))
  cards.push(globalCard())
  const block = renderRecalledBlock(cards, { config: cfg, query, now: Date.now() })
  if (block === '') return ''
  // 引导她主动记：跟整卡路径保持同一句提示。
  return `${block}\n\n觉得该记住的，可以自己用 soul_memory 记下来；要分段、成一个主题的，用 soul_note 写成笔记。记错了都能删。`
}


/** 记忆统计（设置页用）。 */
export function memoryStats(cwd, config = {}) {
  const cfg = normalizeConfig(config)
  const global = status(globalCard(), cfg)
  const project = String(cwd ?? '').trim() !== '' ? status(projectCard(cwd), cfg) : null
  return { global, project, config: cfg }
}
