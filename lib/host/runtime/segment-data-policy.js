/**
 * 宿主装配 · segment-data-policy.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { DATA_BOUNDARY_POLICY } from '../../core/prompt-guard.js'




// ---------------------------------------------------------------------------
// P15：以下 6 个注册函数由 applyInner 的 ctx.effect 块机械提取，块体逐字未改。
// applyInner 现在只做「探测服务 → 注册 API/工具 → 依次注册 6 段 → 启动定时器」。
// P16 会把它们搬到 lib/host/segments/，共享状态改为显式 runtime 对象。
// ---------------------------------------------------------------------------

export function registerDataPolicySegment(ctx, systemPrompt, llm, config) {
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:data-policy',
        order: 270,
        required: true,
        text: () => DATA_BOUNDARY_POLICY
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) return () => {}
      throw error
    }
  }, 'dsh-agent-soul: data boundary policy')
}
