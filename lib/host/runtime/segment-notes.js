/**
 * 宿主装配 · segment-notes.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { loadConfig } from '../../store.js'
import { note } from '../../env.js'
import { renderNotesBlock } from '../../notes.js'


export function registerNotesSegment(ctx, systemPrompt, llm, config) {
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:notes',
        order: 245,
        // required：笔记是她自己写的，精简上下文时也不该整个消失 ——
        // 否则「我写过东西」这件事在部分 agent 上会变成空白。
        required: true,
        text: () => {
          const cfg = loadConfig()
          if (cfg.enabled === false || cfg.notesEnabled === false) return ''
          try {
            return renderNotesBlock({ maxChars: cfg.notesInjectMaxChars })
          } catch (error) {
            // 笔记索引挂了不该连累人格和记忆：返回空串，这一轮就是没有这一段
            note('notes', `索引渲染失败：${error instanceof Error ? error.message : error}`)
            return ''
          }
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) {
        note('apply', 'soul:notes 已注册，跳过重复注册')
        return () => {}
      }
      note('notes', `索引注入注册失败：${error instanceof Error ? error.message : error}`)
      return () => {}
    }
  }, 'dsh-agent-soul: notes context')
}
