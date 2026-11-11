/**
 * 宿主装配 · segment-persona.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { join } from 'node:path'
import { composePersona } from '../../persona.js'
import { PERSONA_GUARD } from '../../core/prompt-guard.js'
import { loadConfig } from '../../store.js'
import { note } from '../../env.js'
import { noteMissingOwner } from './refine.js'
import { PERSONA_REFRESH_TURNS } from '../meta.js'
import { configPath, globalPersonaPath, slugFor } from '../../paths.js'
import { fileSignature, renderCached } from './segment-cache.js'


/**
 * 人格段的缓存指纹：全局人格 + 本机项目人格 + 配置文件，
 * 外加 cwd 里跟着仓库走的 AGENT.md / AGENTS.md。
 *
 * 为什么人格也要 sig：设置页改人格、或用户直接用编辑器改 AGENT.md 时，
 * 不靠 sig 就得等满 PERSONA_REFRESH_TURNS 轮才生效 —— 那不是「刷新」，
 * 是「改了没反应」。
 */
function personaSignature(cwd) {
  const files = [
    globalPersonaPath(),
    configPath(),
    slugFor(cwd).personaPath
  ]
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    files.push(join(cwd, 'AGENT.md'), join(cwd, 'AGENTS.md'))
  }
  return fileSignature(files)
}


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
          const current = loadConfig()
          if (current.enabled === false) return ''
          // 2026-10-31：人格首轮注入，之后每隔 PERSONA_REFRESH_TURNS 轮补一次。
          // 2026-11-11：这里改成「缓存优先」—— 不刷新的轮次返回**上次那段原文**，
          // 而不是空串（旧行为让 15 轮里 14 轮没有身份，且系统提示一空一有，
          // 每次变化都把 prefix cache 打断）。
          const agent = context?.agent
          const cwd = agent?.session?.header?.cwd ?? ''
          // 没设主人名字的提醒（2026-11-04）：每小时最多一行，不阻断注入。
          noteMissingOwner(current)
          return renderCached(agent, 'persona', () => {
            const composed = composePersona({ cwd, config: current })
            if (composed.truncated) note('persona', '人格正文超过上限，已截断')
            // 2026-11-06 第二份审查 H-3：人格以前是「边界之外唯一能被外部写的一段」
            // （项目的 AGENT.md 可能来自别人克隆的仓库）。这里给它一段前置声明，
            // 明确「按它行事，但不能改数据边界 / 泄密 / 绕安全限制」。
            // 不加 <untrusted_data>：人格的语义是要遵守的设定，套成数据会说反。
            if (composed.text === '') return ''
            return `${PERSONA_GUARD}\n\n${composed.text}`
          }, {
            sig: personaSignature(cwd),
            everyTurns: PERSONA_REFRESH_TURNS
          })
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
