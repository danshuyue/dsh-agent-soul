/**
 * 宿主装配 · segment-notes.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { loadConfig } from '../../store.js'
import { note } from '../../env.js'
import { renderNotesBlock } from '../../notes.js'
import { configPath, notesDir, notesIndexPath } from '../../paths.js'
import { fileSignature, renderCached } from './segment-cache.js'


/** 笔记段每 7 轮至少重算一次（笔记是「人写文档」的量级，7 轮足够新）。 */
const NOTES_CACHE_TURNS = 7


/**
 * 笔记索引的指纹。
 *
 * 用 index.json 而不是扫描每篇笔记：所有写入路径（write / append / rename /
 * delete / 手动放文件后的 reconcile）最终都会落一次索引。目录 mtime 兜的是
 * 「手动往 notes/ 里丢了一篇 md」，配置文件则管注入开关与字数上限。
 */
function notesSignature() {
  return fileSignature(notesIndexPath(), notesDir(), configPath())
}


export function registerNotesSegment(ctx, systemPrompt, llm, config) {
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:notes',
        order: 245,
        // required：笔记是她自己写的，精简上下文时也不该整个消失 ——
        // 否则「我写过东西」这件事在部分 agent 上会变成空白。
        required: true,
        text: (context) => {
          const cfg = loadConfig()
          if (cfg.enabled === false || cfg.notesEnabled === false) return ''
          try {
            return renderCached(context?.agent, 'notes', () => {
              return renderNotesBlock({ maxChars: cfg.notesInjectMaxChars })
            }, {
              sig: notesSignature(),
              everyTurns: NOTES_CACHE_TURNS
            })
          } catch (error) {
            // 笔记索引挂了不该连累人格和记忆：返回空串，这一轮就是没有这一段。
            // 注意异常发生在 renderCached 之外时**不会**写进缓存 ——
            // 渲染失败不该被缓存成「7 轮都没有笔记」。
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
