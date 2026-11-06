/**
 * HTTP 路由 · persona.js（2026-11-06 P16）。
 * 由 lib/http/server.js 的 registerApi 分支体经 P15 提取后整体搬来，函数体逐字未改。
 * 分派逻辑仍在 server.js；本文件只负责「某个路由具体做什么」。
 */

import { MAX_INJECT_CHARS, storedProjectPersonaPath } from '../../persona.js'
import { atomicWrite, exists, globalPersonaPath, readText } from '../../paths.js'
import { json, readBody } from '../middleware.js'
import { resolvePostCwd } from '../sessions.js'
import { note } from '../../env.js'
import { statSync } from 'node:fs'


export async function handleGetPersona(ctx, req, res, query, route) {
          const kind = query.get('kind') === 'project' ? 'project' : 'global'
          const cwd = query.get('cwd') ?? ''
          if (kind === 'project' && cwd === '') {
            return json(res, 400, { ok: false, error: '读项目人格要给 cwd' })
          }
          const file = kind === 'project' ? storedProjectPersonaPath(cwd) : globalPersonaPath()
          let updatedAt = null
          try {
            if (exists(file)) updatedAt = statSync(file).mtime.toISOString()
          } catch {
            /* 读不到时间就留空 */
          }
          return json(res, 200, {
            ok: true,
            kind,
            path: file,
            exists: exists(file),
            updatedAt,
            text: readText(file)
          })
}

export async function handlePostPersona(ctx, req, res, query, route) {
          const body = await readBody(req)
          const kind = body?.kind === 'project' ? 'project' : 'global'
          // 2026-11-06 M-5：写侧入口。项目人格文件落在 DSH_HOME 里（slug 决定），
          // 但 slug 来自 cwd —— 不认没归属的 cwd，避免给"任意目录"建一份项目人格。
          const pick = resolvePostCwd(ctx, body)
          const cwd = pick.source === 'body' ? pick.cwd : ''
          const text = String(body?.text ?? '')
          if (kind === 'project' && cwd === '') {
            return json(res, 400, {
              ok: false,
              error: '写项目人格需要一个已登记的工作目录（或当前会话的目录）。新增工作区请用「选择文件夹」。',
              cwdSource: pick.source
            })
          }
          if (text.length > MAX_INJECT_CHARS) {
            return json(res, 400, { ok: false, error: `太长（超过 ${MAX_INJECT_CHARS} 字），后面的内容不会生效` })
          }
          const file = kind === 'project' ? storedProjectPersonaPath(cwd) : globalPersonaPath()
          // 2026-11-04 修 ②：写盘失败必须如实回非 200。
          //
          // 原来的写法是 `atomicWrite(file, text)` 然后无条件 200 { ok: true }：
          // 磁盘满、文件被别的程序占着、目录权限没了的时候，界面照样显示「已保存」，
          // 而下次装配读到的还是旧人格 —— 用户以为改好了，其实一个字都没写进去。
          // 这比报错更糟：报错他会重试，静默成功他不会。
          //
          // atomicWrite 有两种失败：返回 { ok:false }，或第一步写 .tmp 就抛。
          // 两种都收成同一条失败路径，回 500（带原因），并留一行 api 日志。
          let written
          try {
            written = atomicWrite(file, text)
          } catch (error) {
            written = { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
          if (written?.ok !== true) {
            const reason = String(written?.error ?? '未知原因')
            note('api', `人格保存失败（${kind}）：${reason} → ${file}`)
            // 文案写成「写盘失败：…」而不是「保存失败：…」：设置页那边已经统一加了
            // 「保存失败：」前缀（lib/client/persona-tab.js 的 catch），再带一遍就重复了。
            return json(res, 500, { ok: false, error: `写盘失败：${reason}` })
          }
          note('api', `人格已保存（${kind}，${text.length} 字）→ ${file}`)
          return json(res, 200, { ok: true, path: file, chars: text.length })
}
