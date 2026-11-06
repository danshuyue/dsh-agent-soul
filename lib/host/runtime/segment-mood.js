/**
 * 宿主装配 · segment-mood.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { applyMoodDelta, loadConfig } from '../../store.js'
import { isSubagentSession } from '../../extract.js'
import { normalizeMoodConfig, observeAgent, unobserveAll } from '../../mood.js'
import { note } from '../../env.js'
import { noteMissingOwner } from './refine.js'


export function registerMoodHookSegment(ctx, systemPrompt, llm, config) {
  ctx.effect(() => {
    const dispose = (() => {
      try {
        return systemPrompt.context({
          name: 'soul:mood',
          order: 230,
          text: (context) => {
            const cfg = loadConfig()
            if (cfg.enabled === false || cfg.moodEnabled === false) return ''
            // 同上：没设主人名字时每小时提醒一次（不阻断心情记账）
            noteMissingOwner(cfg)
            const agent = context?.agent
            // 子会话不判心情：它是一次性任务上下文，判断结果会按 cwd 记进主会话的账上。
            if (isSubagentSession(agent)) return ''
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
}
