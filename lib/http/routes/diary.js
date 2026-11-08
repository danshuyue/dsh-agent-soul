/**
 * HTTP 路由 · diary.js（2026-11-06 P16）。
 * 由 lib/http/server.js 的 registerApi 分支体经 P15 提取后整体搬来，函数体逐字未改。
 * 分派逻辑仍在 server.js；本文件只负责「某个路由具体做什么」。
 */

import { loadConfig, saveConfig } from '../../store.js'
import { diaryPrivatePath, diaryPublicPath, exists, isDiaryDateKey, readText } from '../../paths.js'
import { currentSessionIdOf, listDiarySessions } from '../sessions.js'
import { json, privateDiaryView, readBody } from '../middleware.js'
import { note, serviceOf, sanitizeLogText } from '../../env.js'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { runDiaryOnce, todayKey } from '../../diary.js'

/** statSync 的竞态安全版：文件在读的瞬间被删/轮转就返回 null，不把整个列表打成 500。 */
function mtimeIsoOf(file) {
  try {
    return statSync(file).mtime.toISOString()
  } catch {
    return null
  }
}

/**
 * 只读文件头部 N 字节（2026-11-08 KNOWN-ISSUES #1）。
 * /diary/list 每天只要前 400 字的预览，原来却整文件读入再 slice ——
 * 30 天循环 × 全量读，打开日记页签明显卡。readFileSync 带 length 也行，
 * 但 open+read 语义更直白：就是读头部，不多读一个字节。
 */
function readHead(file, bytes = 400) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 关不掉就算 */ } }
  }
}


export async function handleGetDiaryList(ctx, req, res, query, route) {
          const days = Math.min(30, Math.max(1, Math.round(Number(query.get('days')) || 14)))
          const today = new Date()
          today.setHours(0, 0, 0, 0)
          const list = []
          for (let i = 0; i < days; i++) {
            const day = new Date(today.getTime() - i * 24 * 60 * 60 * 1000)
            const pad = (n) => String(n).padStart(2, '0')
            const dateStr = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
            const publicFile = diaryPublicPath(dateStr)
            const privateFile = diaryPrivatePath(dateStr)
            const hasPublic = exists(publicFile)
            const hasPrivate = exists(privateFile)
            if (!hasPublic && !hasPrivate) continue
            list.push({
              date: dateStr,
              hasPublic,
              hasPrivate,
              preview: hasPublic ? readHead(publicFile, 400) : '',
              // 2026-11-08 KNOWN-ISSUES #11：exists 与 statSync 之间文件被删/轮转时
              // 原来直接抛 → 整个列表 500。竞态下时间留空即可，列表照常返回。
              updatedAt: hasPublic ? mtimeIsoOf(publicFile) : null
            })
          }
          return json(res, 200, { ok: true, list })
}

export async function handleGetDiaryRead(ctx, req, res, query, route) {
          const dateStr = String(query.get('date') ?? '').trim()
          // 2026-11-05 修 P0-2：这里原来只判非空，`../private/2026-11-02` 会
          // 让公开路径解析到私密目录，把私密正文当 publicContent 吐出去。
          if (!isDiaryDateKey(dateStr)) {
            return json(res, 400, { ok: false, error: '缺少或非法的 date 参数（YYYY-MM-DD）' })
          }
          const publicFile = diaryPublicPath(dateStr)
          const privateFile = diaryPrivatePath(dateStr)
          const hasPublic = exists(publicFile)
          const hasPrivate = exists(privateFile)
          return json(res, 200, {
            ok: true,
            date: dateStr,
            hasPublic,
            hasPrivate,
            publicContent: hasPublic ? readText(publicFile) : '',
            // 私密日记不出服务器，只告诉有没有
          })
}

export async function handleGetDiaryPrivate(ctx, req, res, query, route) {
          const view = privateDiaryView(req, loadConfig())
          return json(res, view.status, view.payload)
}

export async function handleGetDiarySessions(ctx, req, res, query, route) {
          let sessions = []
          try {
            sessions = listDiarySessions(ctx)
          } catch (error) {
            note('api', `日记会话列表生成失败：${error instanceof Error ? error.message : error}`)
          }
          return json(res, 200, { ok: true, sessions })
}

export async function handlePostDiaryBind(ctx, req, res, query, route) {
          const body = await readBody(req)
          let sessionId = String(body?.sessionId ?? '').trim()
          const source = sessionId === '' ? 'recent' : 'client'
          if (sessionId === '') sessionId = currentSessionIdOf(ctx)
          if (sessionId === '') {
            return json(res, 400, { ok: false, error: '拿不到当前会话 id：请求没带，会话服务里也没有可用会话' })
          }
          // 2026-11-04：绑定前探测一次（只 get，**绝不 resume** —— resume 有副作用，
          // 会在用户只是选下拉的时候就真把会话冷启动起来）。
          // get 拿不到 ≠ id 错了：休眠的会话 get 不到，但写日记时 resume 能冷启动，
          // 这是现有设计里的合法路径。所以这里只加 warning，不返回 400。
          // agents 服务不可用 / 探测抛错时一律跳过，照常绑定。
          let probeWarning = ''
          // 2026-11-08 KNOWN-ISSUES #9：sessionId 来自请求体，原样进日志能把一条
          // 审计行拆成伪造的几条 —— 统一过 sanitizeLogText。
          const logSessionId = sanitizeLogText(sessionId)
          try {
            const agents = serviceOf(ctx, 'agents')
            if (agents === undefined || agents === null || typeof agents.get !== 'function') {
              note('api', `日记会话绑定：agents 服务不可用，跳过存在性探测（${logSessionId}）`)
            } else {
              const live = agents.get(sessionId)
              if (live === undefined || live === null) {
                probeWarning = '这个会话现在不活跃，写日记时会尝试冷启动它'
                note('api', `日记会话绑定：${logSessionId} 当前不活跃（agents.get 为空），照常绑定，写日记时会冷启动`)
              }
            }
          } catch (error) {
            note('api', `日记会话绑定：探测 ${logSessionId} 失败，跳过（${error instanceof Error ? error.message : error}）`)
          }
          const bornAt = Date.now()
          const next = saveConfig({ diarySessionId: sessionId, diarySessionBornAt: bornAt })
          note('api', `日记会话已绑定：${logSessionId}（来源 ${sanitizeLogText(source)}，起算 ${bornAt}）`)
          return json(res, 200, {
            ok: true,
            sessionId,
            source,
            bornAt,
            ...(probeWarning === '' ? {} : { warning: probeWarning }),
            config: next
          })
}

export async function handlePostDiaryUnbind(ctx, req, res, query, route) {
          // bornAt 一起清掉：否则概览还会按旧时间显示「日记本 N 天」
          const next = saveConfig({ diarySessionId: '', diarySessionBornAt: 0 })
          note('api', '日记会话绑定已清除')
          return json(res, 200, { ok: true, sessionId: '', config: next })
}

export async function handlePostDiary(ctx, req, res, query, route) {
          const body = await readBody(req)
          const rawDate = String(body?.date ?? '').trim()
          const dateStr = rawDate || todayKey(Date.now())
          // 2026-11-05 修 P0-2：date 会一路传到 writeDiaryFile 的文件名里，
          // 原来 `../../../AGENT` 能把人格文件覆盖成日记正文。
          if (!isDiaryDateKey(dateStr)) {
            return json(res, 400, { ok: false, error: '非法的 date 参数（YYYY-MM-DD）' })
          }
          const noteText = String(body?.note ?? '').trim()
          const config = loadConfig()
          if (config.diaryEnabled === false) {
            return json(res, 403, { ok: false, error: '日记功能已关闭' })
          }
          const ok2 = await runDiaryOnce(ctx, dateStr, noteText || undefined)
          return json(res, ok2 ? 200 : 500, {
            ok: ok2,
            date: dateStr,
            message: ok2 ? '已触发日记写作' : '日记触发失败（无可用会话或 LLM 异常）'
          })
}
