/**
 * HTTP 路由 · self.js（2026-11-21 / 0.10.2）。
 *
 * 心里话只有两个接口，都是给设置页用的：
 *   GET  /self/list  —— 最近 N 天：date + 是否有正文 + 正文
 *   POST /self/save  —— 改 / 删某一天（text 为空 = 删掉该小节）
 *
 * 为什么手动重写由插件写盘：这是**人**在改，不是她写的。
 * 自动流程仍然坚持「插件不落盘、不解析她的回复」，两条路不要混。
 */
import { isDiaryDateKey } from '../../paths.js'
import { listSelfEntries, writeSelfEntry } from '../../diary/self.js'
import { json, readBody } from '../middleware.js'
import { note } from '../../env.js'

export async function handleGetSelfList(ctx, req, res, query, route) {
  const days = Math.min(60, Math.max(1, Math.round(Number(query.get('days')) || 14)))
  return json(res, 200, { ok: true, list: listSelfEntries(days) })
}

export async function handlePostSelfSave(ctx, req, res, query, route) {
  const body = await readBody(req)
  const dateStr = String(body?.date ?? '').trim()
  if (!isDiaryDateKey(dateStr)) {
    return json(res, 400, { ok: false, error: '缺少或非法的 date 参数（YYYY-MM-DD）' })
  }
  const text = typeof body?.text === 'string' ? body.text : ''
  const result = writeSelfEntry(dateStr, text)
  if (result.ok !== true) {
    note('self', `手动保存 ${dateStr} 的心里话失败：${result.error}`)
    return json(res, 500, { ok: false, error: `写盘失败：${result.error}` })
  }
  note('self', `手动${result.hasText ? '保存' : '删除'}了 ${dateStr} 的心里话`)
  return json(res, 200, { ok: true, date: dateStr, hasText: result.hasText })
}
