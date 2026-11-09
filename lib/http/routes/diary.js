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
import { clearToToday, normalizeToToday, readToToday, saveToToday } from '../../diary/to-today.js'

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
 * 30 天循环 × 全量读，打开日记页签明显卡。
 *
 * ⚠️ 2026-11-08 复核补丁：**不能按字节数直接 toString('utf8')**。
 * 400 不是 3 的倍数，而一个汉字占 3 字节 —— 边界必然落在某个字中间，
 * 解出来就是 U+FFFD（预览末尾那个「�」方块）。实测中文正文 100% 触发。
 *
 * 现在多读 3 字节（一个 UTF-8 字符最长 4 字节，多读 3 足以补齐被切断的那个），
 * 解码后如果末尾是被截断的半个字（\uFFFD），把它丢掉。
 */
function readHead(file, bytes = 400) {
  let fd
  try {
    fd = openSync(file, 'r')
    // 多读一个字符的最长剩余字节数，保证被切断的最后一个字能完整解出来
    const want = bytes + 3
    const buf = Buffer.alloc(want)
    const n = readSync(fd, buf, 0, want, 0)
    let text = buf.subarray(0, n).toString('utf8')
    // 只可能有一个残缺字符，且一定在末尾
    if (text.endsWith('\uFFFD')) text = text.slice(0, -1)
    return text
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
          // 「昨天想对今天说的」（2026-11-09 R19 / ⑥）：单独一条返回，不进 list
          // （它不是日记，只是当天有效的一句话；混进列表会变成「第二条日记」）。
          const toToday = loadConfig().diaryToTodayEnabled === false ? null : readToToday(todayKey())
          return json(res, 200, { ok: true, list, toToday })
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

/**
 * 改 / 删「昨天想对今天说的话」（2026-11-09 R19 / ⑥）。
 *
 *   { action: 'edit', text }  —— 改写（当天以改写版为准）
 *   { action: 'delete' }      —— 删掉（当天立刻没有这句）
 *
 * 「她能自己改、你也能删」是它比「直接改人格文件」安全的关键 —— 所以这两个入口必须有。
 */
export async function handlePostDiaryToToday(ctx, req, res, query, route) {
          const body = await readBody(req)
          const config = loadConfig()
          if (config.diaryToTodayEnabled === false) {
            return json(res, 400, { ok: false, error: '这个功能关着（diaryToTodayEnabled=false）' })
          }
          const today = todayKey()
          const action = String(body?.action ?? 'edit').trim()
          if (action === 'delete') {
            const cleared = clearToToday()
            if (cleared.ok !== true) return json(res, 500, { ok: false, error: cleared.error ?? '删除失败' })
            note('diary', `「想对今天说」已删除（${today}）`)
            return json(res, 200, { ok: true, toToday: null })
          }
          if (action !== 'edit') return json(res, 400, { ok: false, error: 'action 只能是 edit 或 delete' })
          const checked = normalizeToToday(body?.text, config.diaryToTodayMaxChars)
          if (checked.ok !== true) {
            return json(res, 400, { ok: false, error: `这句话没采用：${checked.reason}` })
          }
          const saved = saveToToday(today, checked.text, { source: 'user-edit', editedByUser: true })
          if (saved.ok !== true) return json(res, 500, { ok: false, error: saved.error ?? '写盘失败' })
          note('diary', `「想对今天说」被改写（${today}）：${checked.text}`)
          return json(res, 200, { ok: true, toToday: readToToday(today) })
}
