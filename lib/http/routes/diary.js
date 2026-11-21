/**
 * HTTP 路由 · diary.js（2026-11-06 P16）。
 * 由 lib/http/server.js 的 registerApi 分支体经 P15 提取后整体搬来。
 * 2026-11-21 / 0.10.0：产出从「公开 + 私密两篇」改成「一篇摘录」。
 *   · 删掉「读私密正文」与「给明天一句话」两个接口（功能已删，路由不再存在）
 *   · GET /diary/list 返回摘录日期列表；旧日记（public/、private/）只读、标 legacy
 */

import { loadConfig, saveConfig } from '../../store.js'
import { diaryExcerptPath, exists, isDiaryDateKey, readText } from '../../paths.js'
import { excerptLinesFromFile } from '../../diary/excerpt.js'
import { currentSessionIdOf, listDiarySessions } from '../sessions.js'
import { json, readBody } from '../middleware.js'
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

function dateKeyOfDay(day) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/**
 * 摘录列表。
 *
 * 2026-11-21 / 0.10.5：**不再列出旧日记**。旧数据（public/、private/）仍然留在磁盘上，
 * 但设置页不显示了 —— 它们属于 0.10.0 之前的格式，混在摘录列表里只会让人分不清
 * 「这天有没有摘录」。文件本身没有任何写入路径，也不会被删。
 */
export async function handleGetDiaryList(ctx, req, res, query, route) {
          const days = Math.min(30, Math.max(1, Math.round(Number(query.get('days')) || 14)))
          const today = new Date()
          today.setHours(0, 0, 0, 0)
          const list = []
          for (let i = 0; i < days; i++) {
            const day = new Date(today.getTime() - i * 24 * 60 * 60 * 1000)
            const dateStr = dateKeyOfDay(day)
            const excerptFile = diaryExcerptPath(dateStr)
            if (!exists(excerptFile)) continue
            list.push({
              date: dateStr,
              hasExcerpt: true,
              preview: readHead(excerptFile, 400),
              // 2026-11-08 KNOWN-ISSUES #11：exists 与 statSync 之间文件被删/轮转时
              // 原来直接抛 → 整个列表 500。竞态下时间留空即可，列表照常返回。
              updatedAt: mtimeIsoOf(excerptFile)
            })
          }
          return json(res, 200, { ok: true, list })
}

/**
 * 读某一天。
 *
 * 2026-11-21 / 0.10.5：只回摘录。旧日记不再从接口里出（设置页也不显示了）——
 * 文件还在磁盘上，但那是 0.10.0 之前的格式，不属于现在的「日记」。
 */
export async function handleGetDiaryRead(ctx, req, res, query, route) {
          const dateStr = String(query.get('date') ?? '').trim()
          // 2026-11-05 修 P0-2：这里原来只判非空，`../private/2026-11-02` 会
          // 让路径解析到别的目录，把私密正文当公开内容吐出去。
          if (!isDiaryDateKey(dateStr)) {
            return json(res, 400, { ok: false, error: '缺少或非法的 date 参数（YYYY-MM-DD）' })
          }
          const excerptFile = diaryExcerptPath(dateStr)
          const hasExcerpt = exists(excerptFile)
          return json(res, 200, {
            ok: true,
            date: dateStr,
            hasExcerpt,
            excerptContent: hasExcerpt ? readText(excerptFile) : '',
            excerptLines: hasExcerpt ? excerptLinesFromFile(readText(excerptFile)) : []
          })
}

export async function handleGetDiarySessions(ctx, req, res, query, route) {
          let sessions = []
          try {
            sessions = listDiarySessions(ctx)
          } catch (error) {
            note('api', `摘录会话列表生成失败：${error instanceof Error ? error.message : error}`)
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
          // get 拿不到 ≠ id 错了：休眠的会话 get 不到，但写摘录时 resume 能冷启动，
          // 这是现有设计里的合法路径。所以这里只加 warning，不返回 400。
          // agents 服务不可用 / 探测抛错时一律跳过，照常绑定。
          let probeWarning = ''
          // 2026-11-08 KNOWN-ISSUES #9：sessionId 来自请求体，原样进日志能把一条
          // 审计行拆成伪造的几条 —— 统一过 sanitizeLogText。
          const logSessionId = sanitizeLogText(sessionId)
          try {
            const agents = serviceOf(ctx, 'agents')
            if (agents === undefined || agents === null || typeof agents.get !== 'function') {
              note('api', `摘录会话绑定：agents 服务不可用，跳过存在性探测（${logSessionId}）`)
            } else {
              const live = agents.get(sessionId)
              if (live === undefined || live === null) {
                probeWarning = '这个会话现在不活跃，写摘录时会尝试冷启动它'
                note('api', `摘录会话绑定：${logSessionId} 当前不活跃（agents.get 为空），照常绑定，写摘录时会冷启动`)
              }
            }
          } catch (error) {
            note('api', `摘录会话绑定：探测 ${logSessionId} 失败，跳过（${error instanceof Error ? error.message : error}）`)
          }
          const bornAt = Date.now()
          const next = saveConfig({ excerptSessionId: sessionId, excerptSessionBornAt: bornAt })
          note('api', `摘录会话已绑定：${logSessionId}（来源 ${sanitizeLogText(source)}，起算 ${bornAt}）`)
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
          // bornAt 一起清掉：否则概览还会按旧时间显示「摘录本 N 天」
          const next = saveConfig({ excerptSessionId: '', excerptSessionBornAt: 0 })
          note('api', '摘录会话绑定已清除')
          return json(res, 200, { ok: true, sessionId: '', config: next })
}

export async function handlePostDiary(ctx, req, res, query, route) {
          const body = await readBody(req)
          const rawDate = String(body?.date ?? '').trim()
          const dateStr = rawDate || todayKey(Date.now())
          // 2026-11-05 修 P0-2：date 会一路传到写盘的文件名里，
          // 原来 `../../../AGENT` 能把人格文件覆盖成摘录正文。
          if (!isDiaryDateKey(dateStr)) {
            return json(res, 400, { ok: false, error: '非法的 date 参数（YYYY-MM-DD）' })
          }
          const noteText = String(body?.note ?? '').trim()
          const config = loadConfig()
          if (config.diaryEnabled === false) {
            return json(res, 403, { ok: false, error: '摘录功能已关闭' })
          }
          const ok2 = await runDiaryOnce(ctx, dateStr, noteText || undefined)
          return json(res, ok2 ? 200 : 500, {
            ok: ok2,
            date: dateStr,
            message: ok2 ? '已触发摘录写作' : '摘录触发失败（写盘失败或无可用素材）'
          })
}
