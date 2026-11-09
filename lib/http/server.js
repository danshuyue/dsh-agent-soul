/**
 * HTTP 接口 · server.js
 * 由 lib/api.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { API_PREFIX, ASSETS_DIR, ASSET_PREFIX, FACE_ASSETS, PICK_TIMEOUT_MS } from './constants.js'
import { loadConfig } from '../store.js'
import { SESSION_ROUTE, TOKEN_HEADER, checkApiRateLimit, checkHostTrust, checkSessionRateLimit, isAllowedApiHost, isLoopbackHostName, issueSessionToken, noteRemoteHostOnce, rotateApiToken, verifyApiToken } from '../core/api-token.js'
import { slugFor } from '../paths.js'
import { join } from 'node:path'
import { json, shouldAllowApiRequest } from './middleware.js'
import { registerProject } from '../core/registry.js'
import { note, serviceOf } from '../env.js'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { handleGetAttestation, handleGetDiaryList, handleGetDiaryPrivate, handleGetDiaryRead, handleGetDiarySessions, handleGetMemory, handleGetMood, handleGetNotesList, handleGetNotesRead, handleGetPersona, handleGetState, handlePostConfig, handlePostDiary, handlePostDiaryBind, handlePostDiaryToToday, handlePostDiaryUnbind, handlePostGoal, handlePostMaintain, handlePostMemory, handlePostMoodDecay, handlePostMoodReset, handlePostNotesDelete, handlePostNotesRename, handlePostNotesSave, handlePostOpen, handlePostPersona, handlePostRegister, handlePostSecret } from './routes/index.js'

let pickInFlight = false

/**
 * 把 `Host` / `URL.host` 规范化成可比较的「权威」：
 * 小写、去掉默认端口（http:80 / https:443）、IPv6 保留方括号。
 *
 * 2026-11-07 修 R6：反代 + 非默认端口下，用原串比 `Origin` 与 `Host` 会误判跨源
 * （使用方实测 `Host: 127.0.0.1` + `Origin: http://127.0.0.1:8080` → 被拒）。
 */
function normalizeAuthority(value, protocol) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '') return ''
  let host = text
  let port = ''
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end !== -1) {
      port = host.slice(end + 1).replace(/^:/, '')
      host = host.slice(0, end + 1)
    }
  } else {
    const colon = host.lastIndexOf(':')
    if (colon !== -1) {
      port = host.slice(colon + 1)
      host = host.slice(0, colon)
    }
  }
  const isDefault = port === ''
    || (protocol === 'http:' && port === '80')
    || (protocol === 'https:' && port === '443')
  return isDefault ? host : `${host}:${port}`
}

/** 只取主机名（去端口、去默认端口差异），给回环判定用。 */
function hostNameOf(raw) {
  const authority = normalizeAuthority(raw, '')
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    return end === -1 ? authority : authority.slice(0, end + 1)
  }
  const colon = authority.lastIndexOf(':')
  return colon === -1 ? authority : authority.slice(0, colon)
}


/**
 * 2026-11-06 重构 P0：把 spawn 与超时时间做成可注入参数。
 * 原来测试只能断言源码里「有没有 PICK_TIMEOUT_MS 这个字符串」，
 * 现在可以直接注入假 child 验证超时与互斥的真实行为；默认参数保证线上行为不变。
 */
export function pickFolder({ spawnImpl = spawn, timeoutMs = PICK_TIMEOUT_MS } = {}) {
  // 同时弹两个原生对话框会把宿主界面卡死，模块级互斥。
  if (pickInFlight) return Promise.reject(new Error('已有文件夹选择对话框在进行中'))
  pickInFlight = true
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    let child = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      pickInFlight = false
      if (timer !== null) clearTimeout(timer)
      fn(value)
    }
    const plat = process.platform
    let cmd
    let args
    if (plat === 'win32') {
      cmd = 'powershell'
      args = [
        '-NoProfile',
        '-STA',
        '-Command',
        // ① [Console]::OutputEncoding 必须先设成 UTF-8：否则中文路径（例 D:\某个中文目录）会以
        //    控制台代码页（CP936）吐出来，Node 侧按 UTF-8 解码就变成乱码。
        // ② -STA 是 WinForms 对话框的要求，缺了会直接抛。
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms | Out-Null; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择要用项目人格的工作目录'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
      ]
    } else if (plat === 'darwin') {
      cmd = 'osascript'
      args = ['-e', 'POSIX path of (choose folder with prompt "选择要用项目人格的工作目录")']
    } else {
      cmd = 'zenity'
      args = ['--file-selection', '--directory', '--title=选择要用项目人格的工作目录']
    }
    try {
      child = spawnImpl(cmd, args, { windowsHide: true })
    } catch (error) {
      finish(reject, error)
      return
    }
    timer = setTimeout(() => {
      try { child?.kill() } catch { /* 已经退出了 */ }
      finish(reject, new Error(`选择文件夹超时（${timeoutMs / 1000} 秒），已关闭对话框`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('error', (error) => finish(reject, error))
    child.on('exit', () => finish(resolve, out.trim()))
  })
}


export function registerApi(ctx) {
  const webServer = serviceOf(ctx, 'webServer')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    note('api', '宿主没有 webServer 服务，设置页接口未注册')
    return undefined
  }

  /**
   * 真正的请求处理（Origin / Host / 回环 / 令牌 / 路由分发都在这）。
   * 2026-11-07 R8：从 register 的内联 handler 里提出来，外层好加统一的异常兜底。
   */
  const handleApiRequest = async (req, res) => {
      // ---- 跨源防护（CSRF） ----
      // 这套接口没有任何鉴权：POST /persona 能改写人格注入内容，POST /open 能弹 explorer，
      // POST /pick 能弹系统文件选择框。也就是说，你浏览器里随便一个恶意页面
      // fetch('http://127.0.0.1:PORT/api/soul/persona', {method:'POST',...}) 就能改写她的魂。
      //
      // 判据只认「明确是外站」这一种：
      //   · 没带 Origin（同源导航、非浏览器客户端）→ 放行
      //   · Origin 是 'null'（sandboxed iframe / file:// 宿主）→ 放行，拒了会误伤本地 webview
      //   · Origin 是 http(s) 且 host 与本次请求的 Host 对不上 → 拒绝
      // 这样挡掉网页端发起的跨站请求，又不至于把宿主自己锁在门外。
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
        let crossed = false
        try {
          const parsed = new URL(origin)
          const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
          // 非 http(s) 的来源（file://、app://、chrome-extension:// 等）都是本地宿主自己，
          // 一律放行 —— 拒掉它们会把设置页锁在门外，那是比 CSRF 更糟的故障。
          if (isHttp) {
            const originAuthority = normalizeAuthority(parsed.host, parsed.protocol)
            const requestAuthority = normalizeAuthority(req.headers.host, parsed.protocol)
            // 2026-11-07 修 R6：原来用 `String(host).split(':')[1]` 比端口，
            // · Host 不带端口时得到 undefined，永远不相等；
            // · IPv6 的 `[::1]:8080` 被切在 `1]`，也永远不相等。
            // 使用方实测：Host: 127.0.0.1 + Origin: http://127.0.0.1:8080 → 被误判跨源。
            // 现在按「规范化权威」比；另外**两端都是回环**时允许端口不同
            // （设置页由宿主端口提供、API 走另一个端口，这是正常形态）。
            const originLoopback = isLoopbackHostName(hostNameOf(parsed.host))
            const requestLoopback = isLoopbackHostName(hostNameOf(req.headers.host))
            crossed = !(requestAuthority !== ''
              && (originAuthority === requestAuthority || (originLoopback && requestLoopback)))
          }
        } catch {
          crossed = true // Origin 都解析不了，不认
        }
        if (crossed) {
          note('api', `拒绝跨源请求：Origin=${origin} Host=${String(req.headers.host ?? '')}`)
          return json(res, 403, {
            ok: false,
            error: '跨源请求被拒绝',
            origin: String(origin),
            host: String(req.headers.host ?? '')
          })
        }
      }

      const url = (req.url ?? '').split('?')[0]
      const route = url.slice(API_PREFIX.length) || '/'
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')

      // ---- Host 白名单（2026-11-06 修 R3；2026-11-07 修 R6）----
      // 放在最前面，连 /session 也过这道：DNS rebinding 让攻击者页面「同源」读到
      // /session 的响应体从而拿到 token，Origin 检查在这个场景里看不出异常。
      //
      // 2026-11-07：原来只比插件自己的白名单，nginx 反代 + 公网 Host 下整页 403
      // （使用方实测：19 次 /session 全 403）。现在先问宿主的 connection 服务，
      // 宿主认 --trusted-host 就算过；插件白名单退成兜底。
      const trust = await checkHostTrust(req, ctx)
      if (!trust.ok) {
        note('api', `拒绝 Host：${trust.host || '（空）'}（${trust.source}）${req.method} ${route}`)
        return json(res, 403, {
          ok: false,
          error: 'Host 不受信任',
          host: trust.host || '（空）',
          allowedHosts: trust.allowed,
          hint: '宿主侧配置 --trusted-host，或设置 DSH_SOUL_ALLOWED_HOSTS（逗号分隔；注意它只能在 systemd Environment= / export 里设，写进 .env 会让 dsh 起不来）'
        })
      }
      if (trust.source === 'host-trusted' || trust.source === 'whitelist') {
        noteRemoteHostOnce(trust.source, trust.host)
      }

      // ---- 本机回环校验（2026-11-04 修 ⑤）----
      // 放在 Origin 检查之后、路由分发之前：Origin 那道只挡「网页跨站」，
      // 对「本机另一个进程」完全无效（那种请求通常根本不带 Origin）。
      // 这里补上真正的权限边界 —— 私密日记的闸门也是同一个判据，两处对齐。
      if (!shouldAllowApiRequest(req, loadConfig())) {
        note('api', `拒绝非回环请求：${req.method} ${route} 来自 ${String(req?.socket?.remoteAddress ?? '未知')}`)
        return json(res, 403, { ok: false, error: '只允许本机访问（apiLoopbackOnly=false 可关闭此限制）' })
      }

      // ---- 会话令牌（2026-11-05 修 P0-1 余下 / S2）----
      // /session 是唯一的免令牌端点：同源页面读它拿进程内随机 token，之后每个
      // 请求都要带 x-soul-token。响应刻意不带 CORS 头 —— 跨源页面发得出这个 GET，
      // 但浏览器不给它的 JS 读响应体，所以拿不到 token（标准 CSRF token 思路）。
      // 边界要说清楚：本机任意进程仍可自己 GET 一次，那属于 OS 权限层，
      // 纯插件侧没有可信注入通道，见 lib/core/api-token.js 文件头与报告 11.6。
      if (route === SESSION_ROUTE && req.method === 'GET') {
        if (!checkSessionRateLimit(req)) {
          return json(res, 429, { ok: false, error: '令牌发放过于频繁，稍后再试' })
        }
        const issued = issueSessionToken(req)
        if (issued.ok !== true) return json(res, issued.status, { ok: false, error: issued.error })
        return json(res, 200, { ok: true, token: issued.token })
      }
      // 2026-11-07 R10 / P2-15：手动轮换。要带当前令牌 —— 没令牌的人本来也用不了接口，
      // 这里只是让「我怀疑泄露了」有一个不用重启的动作。
      if (route === '/session/rotate' && req.method === 'POST') {
        if (!verifyApiToken(req)) {
          return json(res, 401, { ok: false, error: '轮换需要带当前令牌', header: TOKEN_HEADER })
        }
        const rotated = rotateApiToken()
        if (rotated.ok !== true) {
          return json(res, 400, { ok: false, error: rotated.reason ?? '无法轮换', mode: rotated.mode })
        }
        note('api', '会话令牌已按请求手动轮换（旧令牌立即失效）')
        return json(res, 200, { ok: true, token: rotated.token, mode: rotated.mode })
      }
      if (!checkApiRateLimit(req)) {
        return json(res, 429, { ok: false, error: '请求过于频繁，稍后再试' })
      }
      if (!verifyApiToken(req)) {
        note('api', `拒绝无令牌请求：${req.method} ${route}`)
        return json(res, 401, {
          ok: false,
          error: '缺少或无效的会话令牌，请先 GET /api/soul/session',
          header: TOKEN_HEADER
        })
      }
      try {
        // ---- 装配证词：这一次装配到底带上了 soul 的哪几段（2026-11-02） ----
        // 只读。`observed:false` 的含义很确切：一次装配都没观测到，也就是
        // **观测器自己没跑起来**，而不是「没注入」。这两件事必须分开报，
        // 否则看门狗死了还会显示「一切正常」。
        if (route === '/attestation' && req.method === 'GET') return await handleGetAttestation(ctx, req, res, query, route)

        // ---- 人格文件：读 ----
        if (route === '/persona' && req.method === 'GET') return await handleGetPersona(ctx, req, res, query, route)

        // ---- 人格文件：写 ----
        if (route === '/persona' && req.method === 'POST') return await handlePostPersona(ctx, req, res, query, route)

        // ---- 在系统文件管理器里选中人格文件 ----
        // 有些人就是想用 VS Code 改，别逼他在浏览器的 textarea 里写 Markdown。
        if (route === '/open' && req.method === 'POST') return await handlePostOpen(ctx, req, res, query, route)

        // ---- 首屏：一次拿全 ----
        if (route === '/state' && req.method === 'GET') return await handleGetState(ctx, req, res, query, route)

        // ---- 保存配置 ----
        if (route === '/config' && req.method === 'POST') return await handlePostConfig(ctx, req, res, query, route)

        // ---- 存密钥（只进不出：返回的永远只是状态，不回显明文）----
        if (route === '/secret' && req.method === 'POST') return await handlePostSecret(ctx, req, res, query, route)

        // ---- 列记忆 ----
        if (route === '/memory' && req.method === 'GET') return await handleGetMemory(ctx, req, res, query, route)

        // ---- 增 / 改 / 删一条记忆 ----
        if (route === '/memory' && req.method === 'POST') return await handlePostMemory(ctx, req, res, query, route)

        // ---- 手动维护 ----
        if (route === '/maintain' && req.method === 'POST') return await handlePostMaintain(ctx, req, res, query, route)

        // ---- 心情：读全量（值 + 七情 + 时间线） ----
        if (route === '/mood' && req.method === 'GET') return await handleGetMood(ctx, req, res, query, route)

        // ---- 心情：重置 ----
        if (route === '/mood/reset' && req.method === 'POST') return await handlePostMoodReset(ctx, req, res, query, route)

        // ---- 心情：手动跑一次时间衰减（页面刷新时用，幂等） ----
        if (route === '/mood/decay' && req.method === 'POST') return await handlePostMoodDecay(ctx, req, res, query, route)

        // ---- 目标：关掉一条 ----
        if (route === '/goal' && req.method === 'POST') return await handlePostGoal(ctx, req, res, query, route)

        // ---- 登记工作区（设置页「使用」按钮：手填/选中的目录切过去） ----
        if (route === '/register' && req.method === 'POST') return await handlePostRegister(ctx, req, res, query, route)

        // ---- 系统「选择文件夹」：让任意目录都能成为项目人格的归属 ----
        if (route === '/pick' && req.method === 'POST') return await handlePostPick(ctx, req, res, query, route)

        // ---- 日记：列表（只列公开日记的预览；私密内容不出服务器） ----
        if (route === '/diary/list' && req.method === 'GET') return await handleGetDiaryList(ctx, req, res, query, route)

        // ---- 日记：读取某一天（私密不出服务器，只返回存在性） ----
        if (route === '/diary/read' && req.method === 'GET') return await handleGetDiaryRead(ctx, req, res, query, route)

        // ---- 日记：读私密正文（2026-10-31；仅回环 + 显式开启） ----
        // 默认 diaryPrivateVisible=false 时这里一律 403，行为和以前一样：
        // 私密只报存在性，正文永不出服务器。开关打开也只对本机回环放行。
        if (route === '/diary/private' && req.method === 'GET') return await handleGetDiaryPrivate(ctx, req, res, query, route)

        // ---- 日记：可选会话（2026-11-04） ----
        // 设置页的下拉要能看到「任意会话」，不只是当前这个。列表失败不报 500：
        // 返回空数组，页面仍有「刷新列表」按钮可以重试。
        if (route === '/diary/sessions' && req.method === 'GET') return await handleGetDiarySessions(ctx, req, res, query, route)

        // ---- 日记：绑定当前会话 / 清除绑定（2026-10-31） ----
        // 为什么绑：agents.create 造出来的日记会话没有宿主的标准工具集，写不出文件。
        // 只接受明确的会话 id；请求没带就取「最近更新的会话」（这台 DSH 的设置页
        // 拿不到 sessionId，见 currentSessionIdOf 的注释）。
        if (route === '/diary/bind' && req.method === 'POST') return await handlePostDiaryBind(ctx, req, res, query, route)

        if (route === '/diary/unbind' && req.method === 'POST') return await handlePostDiaryUnbind(ctx, req, res, query, route)

        // ---- 手动触发日记 ----
        if (route === '/diary' && req.method === 'POST') return await handlePostDiary(ctx, req, res, query, route)

        // ---- 「昨天想对今天说的」：改写 / 删掉（2026-11-09 R19 / ⑥）----
        if (route === '/diary/to-today' && req.method === 'POST') return await handlePostDiaryToToday(ctx, req, res, query, route)

        // ---- 笔记（2026-11-04）：她自己写的 md ----
        //
        // 跟私密日记的处理不一样：日记是「写给自己看的」，所以正文不出服务器；
        // 笔记是「她自己整理的东西」，没有那一层私密约定，设置页该能看、能改、能删。
        // 她写了什么你都能在这里看到 —— 这也是这个功能有意思的地方。
        if (route === '/notes/list' && req.method === 'GET') return await handleGetNotesList(ctx, req, res, query, route)

        if (route === '/notes/read' && req.method === 'GET') return await handleGetNotesRead(ctx, req, res, query, route)

        if (route === '/notes/save' && req.method === 'POST') return await handlePostNotesSave(ctx, req, res, query, route)

        if (route === '/notes/rename' && req.method === 'POST') return await handlePostNotesRename(ctx, req, res, query, route)

        if (route === '/notes/delete' && req.method === 'POST') return await handlePostNotesDelete(ctx, req, res, query, route)

        return json(res, 404, { ok: false, error: `不认识的路由：${route}` })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 2026-11-06 审计 P1-2：内部异常原文不回给客户端。
        // ENOENT 里带着绝对路径（C:\Users\<用户名>\...），一个错误就能把本机目录结构
        // 和用户名交出去；webview / 别的渲染进程读到的就是这些。原因留在 soul.log。
        note('api', `${route} 出错：${message}`)
        // 2026-11-08 KNOWN-ISSUES #10：handler 主动抛出的带 status 错误（如 readBody
        // 的 413）按它自己的状态码回 —— 那不是「插件内部错误」，是客户端的请求有问题。
        const thrown = Number(error?.status)
        if (Number.isInteger(thrown) && thrown >= 400 && thrown <= 599 && thrown !== 500) {
          return json(res, thrown, { ok: false, error: message })
        }
        const code = `SOUL_${Date.now().toString(36)}`
        note('api', `对外返回固定文案，追踪码 ${code}`)
        return json(res, 500, {
          ok: false,
          error: '插件内部错误，详情见 agents/soul.log',
          code
        })
      }
    }

  const dispose = webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
      // 2026-11-07 R8（P3「鉴权链在 try/catch 之外裸奔」）：
      // Origin / Host / 回环 / 令牌四段校验原来直接写在 handler 体里，没有任何兜底。
      // 今天这几段都不会抛，但只要将来有人往里加一句会抛的调用（解析、网络、宿主 API），
      // 异常就会逃出 webServer → 未捕获 → **整个宿主进程退出**。
      // 一层 catch 换来的代价是零，换来的是「最坏也只是这个请求 500」。
      return handleApiRequest(req, res).catch((error) => {
        const code = `SOUL_${Date.now().toString(36)}`
        note('api', `接口处理异常（${code}）：${error instanceof Error ? error.stack ?? error.message : error}`)
        try {
          if (res.headersSent === true) {
            res.end()
            return
          }
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: '内部错误，详情见 agents/soul.log', code }))
        } catch {
          /* 连接已经断了，没什么可做的 */
        }
      })
    }
  })

  if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-agent-soul: http api')
  }
  note('api', `设置页接口已注册 ${API_PREFIX}`)
  return dispose
}


/**
 * 表情图那五张 PNG 走这儿出去。
 * 之前用的是系统 emoji（😊🙂那种），跟原插件那套画不一致 —— 现在直接给图。
 * 只此五张、只读，顺永远不会变，所以缓存直接拉到最长。
 */
export function registerAssets(ctx) {
  const webServer = serviceOf(ctx, 'webServer')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    note('api', '宿主没有 webServer 服务，表情图未注册')
    return undefined
  }
  const dispose = webServer.register({
    kind: 'prefix',
    path: ASSET_PREFIX,
    handler: (req, res) => {
      // 2026-11-06 审计 P1-1：静态资源是**独立注册**的路由，原来完全不走
      // API 那条 Origin / Host / 回环链 —— 架构上就是一个免鉴权的出口。
      // 现在只读 5 张固定 PNG，危害有限，但出口本身不该存在：把最小面那道门补上。
      //
      // 2026-11-07 修 R6：Host 判定和 API 对齐（以宿主为准），否则 nginx 反代下
      // 表情图会 403。这里做成「同步快路径 + 异步慢路径」：
      // 插件白名单直接命中就走同步（本机、以及配了 DSH_SOUL_ALLOWED_HOSTS 的部署），
      // 只有白名单没命中时才去问宿主的 connection 服务，不改变本机路径的时序。
      const serve = () => {
        if (!shouldAllowApiRequest(req)) return forbidden(res)
        const url = (req.url ?? '').split('?')[0]
        const raw = url.slice(ASSET_PREFIX.length).replace(/^\/+/, '')
        // 2026-11-06 修 R16：坏转义（比如单个 `%`）会让 decodeURIComponent 抛 URIError，
        // 而这里是同步 handler，抛出去就是一次未捕获异常。按 404 处理。
        let name = ''
        try {
          name = decodeURIComponent(raw)
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        serveAsset(name, res)
      }

      if (isAllowedApiHost(req)) {
        serve()
        return
      }
      void checkHostTrust(req, ctx).then((trust) => {
        if (!trust.ok) return forbidden(res)
        noteRemoteHostOnce(trust.source, trust.host)
        serve()
      }).catch(() => forbidden(res))
    }
  })

  if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-agent-soul: assets')
  }
  note('api', `表情图已注册 ${ASSET_PREFIX}（${FACE_ASSETS.size} 张）`)
  return dispose
}

function forbidden(res) {
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('forbidden')
}

/** 真正把 PNG 发出去（鉴权已在 registerAssets 的 handler 里做过）。 */
function serveAsset(name, res) {
  if (!FACE_ASSETS.has(name)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  try {
    const bytes = readFileSync(join(ASSETS_DIR, name))
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': bytes.length,
      // 文件名不带版本号，但内容从不改 → 让浏览器只取一次
      'Cache-Control': 'public, max-age=31536000, immutable'
    })
    res.end(bytes)
  } catch {
    note('api', `表情图读不出来：${name}（assets 目录丢了？${ASSETS_DIR}）`)
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}


// ---------------------------------------------------------------------------
// P15：以下 handler 由 registerApi 的分支体机械提取，块体逐字未改（含缩进）。
// 分派与实现分离后，P16 才能把它们整体搬到 lib/http/routes/ 而不动行为。

// ---------------------------------------------------------------------------


async function handlePostPick(ctx, req, res, query, route) {
          try {
            const picked = await pickFolder()
            if (picked === '') return json(res, 200, { picked: '', cancelled: true })
            registerProject(picked, { active: false })
            return json(res, 200, { picked, cancelled: false, slug: slugFor(picked).slug })
          } catch (error) {
            // 2026-11-07 第二份审查 P1-S4：原来把 error.message 原样带出去，
            // 里面可能有完整路径与用户名。统一「对外固定文案 + 追踪码，原因只进日志」。
            const reason = error instanceof Error ? error.message : String(error)
            const code = `SOUL_${Date.now().toString(36)}`
            note('api', `选择文件夹失败（${code}）：${reason}`)
            return json(res, 500, {
              ok: false,
              error: '打不开系统文件夹选择器，详情见 agents/soul.log；也可以直接在设置页的下拉框里选一个已有的工作区。',
              code
            })
          }
}
