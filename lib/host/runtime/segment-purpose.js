/**
 * 宿主装配 · segment-purpose.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { lastAssistantTextOf } from '../../mood.js'
import { PURPOSE_FILE, loadConfig, purposeState, savePurposeState } from '../../store.js'
import { markServed, openGoals, renderPurpose, settleServed } from '../../purpose.js'
import { memoPerStep } from './turns.js'
import { note } from '../../env.js'
import { configPath, shortHash } from '../../paths.js'
import { briefOf, daysSinceLastChat, situationOf } from '../../core/situation.js'
import { fileSignature, renderCached } from './segment-cache.js'


/** 目的段每 7 轮至少重算一次。 */
const PURPOSE_CACHE_TURNS = 7


/**
 * 目的段的指纹。
 *
 * 除 purpose.json / 配置文件之外，**必须带上情境文本的指纹**：
 * 「现在是晚上 / 隔了几天没说话」这类内容不是文件、但每轮都会变；
 * 不带进去的话，晚上 23 点还在说「下午好」，直到 7 轮后或写盘为止。
 * 情境文本本身只有一句，算它比重新渲染整段便宜得多。
 *
 * sig 里不拼驱动数值：驱动写在 purpose.json 里，mtime 已经覆盖。
 */
function purposeSignature(situationText) {
  return [
    fileSignature(PURPOSE_FILE(), configPath()),
    shortHash(String(situationText ?? ''))
  ].join('|')
}


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
            // 注意：这一步是**副作用**，缓存命中也要照跑（它决定驱动怎么衰减）。
            const settled = settleServed(state, { assistantText: replyNow })
            if (settled.sent.length > 0) {
              note('purpose', `惦记的事说出口了 ${settled.sent.length} 条，驱动回落`)
            }
            // 现实情境（2026-11-09 R19 / ④）：只取一句很短的状态，跟着「惦记的事」一起发。
            // 关掉时传空串 —— renderPurpose 那边就不加那一行，逐字节等价。
            const situationText = cfg.situationEnabled === false
              ? ''
              : briefOf(situationOf(Date.now(), { daysAgo: daysSinceLastChat() }))
            // 缓存只包渲染那一步：上面的结算与下面的 markServed 都是每轮要做的副作用。
            const text = renderCached(context?.agent, 'purpose', () => {
              return renderPurpose(state, { maxGoals: 3, situation: situationText })
            }, {
              sig: purposeSignature(situationText),
              everyTurns: PURPOSE_CACHE_TURNS
            })
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
