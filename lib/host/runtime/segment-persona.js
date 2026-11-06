/**
 * 宿主装配 · segment-persona.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { composePersona } from '../../persona.js'
import { loadConfig } from '../../store.js'
import { note } from '../../env.js'
import { noteMissingOwner } from './refine.js'
import { shouldInjectPersona } from './turns.js'


export function registerPersonaSegment(ctx, systemPrompt, llm, config) {
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:persona',
        order: 260,
        // required：人格是「她是谁」，不能因为是精简上下文（includeRuntimeContext=false）
        // 就整个丢掉 —— 那种模式下 agent 会变得没有身份。
        required: true,
        text: (context) => {
          if (loadConfig().enabled === false) return ''
          // 2026-10-31：人格只在会话首轮注入，之后每隔 PERSONA_REFRESH_TURNS 轮补一次。
          // 不每轮重发（树树说的：不想让用不到的东西持续做无用消耗），
          // 也不注入一次就再也不管（上下文压缩之后会把自己是谁也压掉）。
          if (!shouldInjectPersona(context?.agent)) return ''
          const cwd = context?.agent?.session?.header?.cwd ?? ''
          const current = loadConfig()
          // 没设主人名字的提醒（2026-11-04）：每小时最多一行，不阻断注入。
          noteMissingOwner(current)
          const composed = composePersona({ cwd, config: current })
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
}
