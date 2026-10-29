/**
 * index.js —— dsh-agent-soul 插件入口。
 *
 * 它做四件事，都在同一个插件里：
 *   1. **人格**：把「项目 AGENT.md / 项目人格 / 全局人格」按小节合并后注入系统提示；
 *   2. **记忆**：把衰减记忆卡渲染成一段注入；同时每回合从会话事件里增量提炼新记忆；
 *   3. **目的**：把「心里惦记的事 + 此刻状态」注入，让她的主动行为有连续性；
 *   4. **心情**：每轮判断一次心情变化（心情值 / 七情 / 时间线），**只记账不注入**。
 *
 * ── 为什么注入用 systemPrompt.context 而不是别的钩子 ──
 *   `text` 是**函数**，每次装配提示词都会调用，并且拿到 `context.agent` ——
 *   于是「不同项目不同人格」「记忆随时间变化」「惦记的事会更新」都天然成立，
 *   不需要会话钩子，也没有缓存过期问题。
 *   DSH 只在渲染文本**变化时**才重新追加这一段，所以稳定前缀的缓存不会被打断。
 *
 * ── 心情为什么也挂在 text() 上但返回空串 ──
 *   心情是「每轮判断一次」的记账模块，不该占提示词预算（用户明确要取消每回合注入）。
 *   但 text() 恰好是每轮都会被调用、又拿得到 agent 的地方 ——
 *   在这里懒挂 turn-stopping 监听（挂一次即可），返回 '' 就等于零注入。
 *
 * ── 注入顺序（order） ──
 *   230 心情钩子（空串） → 240 目的 → 250 记忆 → 260 人格。
 *   先给「我惦记什么、我记得什么」，再给「我是谁」，读起来最自然；
 *   而且人格在最贴近用户消息的位置，压得住前面那些事实性内容。
 */
import { note, serviceOf } from './env.js'
import { composePersona } from './persona.js'
import { collectCandidates, ingestCandidates } from './extract.js'
import { addRecord } from './memory.js'
import {
  cardsFor,
  globalCard,
  loadConfig,
  maintain,
  projectCard,
  renderMemoryBlock,
  saveGlobalCard,
  saveProjectCard,
  applyMoodDelta
} from './store.js'
import { purposeState, savePurposeState } from './store.js'
import { satisfyDrives, summarize, openGoals, renderPurpose } from './purpose.js'
import { observeAgent, unobserveAll, normalizeMoodConfig } from './mood.js'
import { registerMemoryTool, registerGoalTool, setFallbackCwd } from './tool.js'
import { registerApi, registerAssets } from './api.js'

/** 插件名 = 裸包名，必须与 package.json 的 name、cordis.patch.yml 的 name、插件目录名三者一致。 */
export const name = 'dsh-agent-soul'
/** 声明式依赖：没有 inject，读 ctx.systemPrompt / ctx.tools 会直接抛。 */
export const inject = ['systemPrompt', 'tools', 'webServer']

/** 记忆维护的最小间隔（毫秒）：注入每回合都跑，但维护不必。 */
const MAINTAIN_INTERVAL_MS = 10 * 60 * 1000

let lastMaintainAt = 0

/** 注入时的轻量维护：衰减/压缩按自己的节奏，提取每回合都做（增量，很便宜）。 */
function tick(agent, cwd, config, { allowMaintain = true } = {}) {
  const now = Date.now()
  if (allowMaintain && now - lastMaintainAt > MAINTAIN_INTERVAL_MS) {
    lastMaintainAt = now
    try {
      const report = maintain(cwd, config)
      if (report.decayed.length > 0 || report.compacted.length > 0) {
        note('tick', `维护完成：衰减 ${report.decayed.join('/') || '无'}，压缩 ${report.compacted.length} 处`)
      }
    } catch (error) {
      note('tick', `维护失败：${error instanceof Error ? error.message : error}`)
    }
  }

  if (agent === undefined || agent === null) return
  try {
    const { candidates } = collectCandidates(agent, { limit: config.maxPerTick ?? 12 })
    if (candidates.length === 0) return
    // 自动记进**项目卡**（有 cwd 时），否则全局卡：跟随当前工作上下文，避免跨项目污染
    const useProject = String(cwd ?? '').trim() !== '' && config.projectMemoryEnabled !== false
    const card = useProject ? projectCard(cwd) : globalCard()
    const written = ingestCandidates(card, addRecord, candidates, config, Date.now())
    if (written > 0) {
      if (useProject) saveProjectCard(cwd, card)
      else saveGlobalCard(card)
    }
  } catch (error) {
    note('extract', `提取失败：${error instanceof Error ? error.message : error}`)
  }
}

export function apply(ctx) {
  note('apply', `启动 pid=${process.pid} node=${process.version}`)
  const config = loadConfig()

  try {
    registerApi(ctx)
  } catch (error) {
    // API 注册失败不该连累注入
    note('api', `注册失败：${error instanceof Error ? error.message : error}`)
  }

  try {
    registerAssets(ctx)
  } catch (error) {
    // 表情图挂了也只是设置页缺图，不影响心情记账
    note('api', `表情图注册失败：${error instanceof Error ? error.message : error}`)
  }

  registerMemoryTool(ctx)
  registerGoalTool(ctx)

  if (config.enabled === false) {
    note('apply', '配置里 enabled=false，只注册 API 与工具，不注入')
    return
  }

  // 注入前先取服务：有些宿主把它挂在 ctx 属性上，有些只走 ctx.get()。
  // 只认一种的话，另一种会静默失效 —— 表现是「设置里看得见插件，但人格没注入」。
  const systemPrompt = serviceOf(ctx, 'systemPrompt')
  if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.context !== 'function') {
    note('apply', '宿主没有 systemPrompt.context，人格/记忆/目的三段都无法注入')
    return
  }

  // ---- 1. 人格段 ----
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:persona',
        order: 260,
        text: (context) => {
          if (loadConfig().enabled === false) return ''
          const cwd = context?.agent?.session?.header?.cwd ?? ''
          const composed = composePersona({ cwd, config: loadConfig() })
          if (composed.truncated) note('persona', '人格正文超过上限，已截断')
          return composed.text
        }
      })
    } catch (error) {
      // 幂等保护：loader 偶尔会在无 scope 的 ctx 上装配两次，同名重复注册会抛
      if (error instanceof Error && error.message.includes('already registered')) {
        note('apply', 'soul:persona 已注册，跳过重复注册')
        return () => {}
      }
      throw error
    }
  }, 'dsh-agent-soul: persona context')

  // ---- 2. 记忆段 ----
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:memory',
        order: 250,
        text: (context) => {
          const cfg = loadConfig()
          if (cfg.enabled === false || cfg.memoryEnabled === false) return ''
          const agent = context?.agent
          const cwd = agent?.session?.header?.cwd ?? ''
          if (typeof cwd === 'string' && cwd !== '') setFallbackCwd(cwd)
          // 顺手做增量提取与例行维护：不阻塞注入（同步做完，成本极低）
          tick(agent, cwd, cfg)
          return renderMemoryBlock(cwd, cfg)
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) {
        note('apply', 'soul:memory 已注册，跳过重复注册')
        return () => {}
      }
      throw error
    }
  }, 'dsh-agent-soul: memory context')

  // ---- 3. 目的段 ----
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:purpose',
        order: 240,
        text: () => {
          const cfg = loadConfig()
          if (cfg.enabled === false || cfg.purposeEnabled === false) return ''
          try {
            return renderPurpose(purposeState(), { maxGoals: 3 })
          } catch (error) {
            note('purpose', `渲染失败：${error instanceof Error ? error.message : error}`)
            return ''
          }
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) {
        note('apply', 'soul:purpose 已注册，跳过重复注册')
        return () => {}
      }
      throw error
    }
  }, 'dsh-agent-soul: purpose context')

  // ---- 4. 心情：每轮钩子（返回空串 = 零注入） ----
  // text() 每次装配都被调用、拿得到 agent —— 正好在这里懒挂 turn-stopping。
  // 判断是异步的、结果只落盘（mood/ 目录），不占提示词预算、没有挂饰。
  const llm = serviceOf(ctx, 'llm')
  if (llm === undefined || llm === null) {
    note('apply', '宿主没有 llm 服务，心情判断不会跑（只影响心情，其余功能正常）')
  }
  ctx.effect(() => {
    const dispose = (() => {
      try {
        return systemPrompt.context({
          name: 'soul:mood',
          order: 230,
          text: (context) => {
            const cfg = loadConfig()
            if (cfg.enabled === false || cfg.moodEnabled === false) return ''
            const agent = context?.agent
            if (agent !== undefined && agent !== null && llm !== undefined && llm !== null) {
              // 幂等：observeAgent 内部按 agent 去重，挂一次就够
              observeAgent(agent, {
                llm,
                note,
                config: () => {
                  const cur = normalizeMoodConfig(loadConfig())
                  // cwd 在判定落下那一刻才读：同一 agent 会话中途改工作区也能对上号
                  const cwd = agent?.session?.header?.cwd ?? ''
                  return {
                    ...cur,
                    applyMoodDelta: (delta, opts) => applyMoodDelta(cwd, delta, opts)
                  }
                }
              })
            }
            return ''
          }
        })
      } catch (error) {
        if (error instanceof Error && error.message.includes('already registered')) {
          note('apply', 'soul:mood 已注册，跳过重复注册')
          return () => {}
        }
        throw error
      }
    })()
    return () => {
      unobserveAll()
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-agent-soul: mood hook')

  note('apply', `注入已就绪：人格/记忆/目的三段 + 心情记账，模式=${loadConfig().mode}`)
}

/** 测试用：重置内部计时器与心情钩子。 */
export function __resetForTest() {
  lastMaintainAt = 0
  unobserveAll()
}

export { cardsFor, summarize, openGoals, satisfyDrives, savePurposeState, applyMoodDelta }
