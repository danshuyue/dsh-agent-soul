/**
 * 宿主装配 · segment-purpose.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { lastAssistantTextOf } from '../../mood.js'
import { loadConfig, purposeState, savePurposeState } from '../../store.js'
import { markServed, openGoals, renderPurpose, settleServed } from '../../purpose.js'
import { memoPerStep } from './turns.js'
import { note } from '../../env.js'
import { briefOf, daysSinceLastChat, situationOf } from '../../core/situation.js'


export function registerPurposeSegment(ctx, systemPrompt, llm, config) {
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:purpose',
        order: 240,
        // required：惦记的事是她主动性的来源，精简上下文时也不该被砍掉。
        required: true,
        text: memoPerStep('purpose', (context) => {
          const cfg = loadConfig()
          if (cfg.enabled === false || cfg.purposeEnabled === false) return ''
          try {
            const state = purposeState()
            const replyNow = lastAssistantTextOf(context?.agent?.session)
            // 先消化上一轮：渲染出去的目标，她有没有真的说出口。
            // satisfyDrives 只在这里被调用 —— 在此之前它是一段没人接的死代码。
            const settled = settleServed(state, { assistantText: replyNow })
            if (settled.sent.length > 0) {
              note('purpose', `惦记的事说出口了 ${settled.sent.length} 条，驱动回落`)
            }
            // 现实情境（2026-11-09 R19 / ④）：只取一句很短的状态，跟着「惦记的事」一起发。
            // 关掉时传空串 —— renderPurpose 那边就不加那一行，逐字节等价。
            const situationText = cfg.situationEnabled === false
              ? ''
              : briefOf(situationOf(Date.now(), { daysAgo: daysSinceLastChat() }))
            const text = renderPurpose(state, { maxGoals: 3, situation: situationText })
            // 记下这一轮渲染出去的目标 + **此刻的回复指纹**，下一轮拿它判断
            // 「她在那之后说过话没有」（2026-11-06 审计 P1-5，取代 60 秒墙钟）
            const marked = markServed(state, openGoals(state, { limit: 3 }), Date.now(), replyNow)
            if (settled.sent.length > 0 || settled.skipped.length > 0 || marked) savePurposeState(state)
            return text
          } catch (error) {
            note('purpose', `渲染失败：${error instanceof Error ? error.message : error}`)
            return ''
          }
        })
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) {
        note('apply', 'soul:purpose 已注册，跳过重复注册')
        return () => {}
      }
      throw error
    }
  }, 'dsh-agent-soul: purpose context')
}
