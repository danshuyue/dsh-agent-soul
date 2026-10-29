/**
 * api.js —— 设置页用的同源 HTTP 接口。
 *
 * 为什么走同源 HTTP 而不是 RPC：
 *   浏览器半侧只要能 fetch 就能用，不需要理解宿主的 RPC 协议；
 *   而且插件被卸载/重装时，页面顶多拿到 404，不会把宿主会话搞坏。
 *
 * 路由（前缀 /api/soul）：
 *   GET  /state          配置 + 人格来源 + 记忆统计 + 目的摘要 + 心情摘要（页面首屏一次拿全）
 *   POST /config         保存配置
 *   GET  /persona        读人格文件
 *   POST /persona        写人格文件
 *   GET  /memory         列记忆（?scope=global|project&cwd=...&query=...）
 *   POST /memory         增 / 改 / 删一条记忆
 *   POST /maintain       手动跑一次衰减与压缩
 *   GET  /mood           心情全量（值 + 七情 + 时间线）
 *   POST /mood/reset     重置心情
 *   POST /mood/decay     手动跑一次时间衰减
 *   POST /diary          手动触发日记（{ date?: "YYYY-MM-DD", note?: "备注" }）
 *   GET  /diary/list     日记列表（最近 N 天，公开日记带预览，私密只报存在性）
 *   GET  /diary/read     读某一天的日记（公开全文，私密只报存在性）
 */
import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { note, serviceOf } from './env.js'
import { composePersona, localPersonaPath, MAX_INJECT_CHARS, resolveSources, storedProjectPersonaPath } from './persona.js'
import {
  archivePath,
  atomicWrite,
  exists,
  globalPersonaPath,
  normalizePathKey,
  readText,
  slugFor,
  diaryPublicDir,
  diaryPrivateDir,
  diaryPublicPath,
  diaryPrivatePath
} from './paths.js'
import {
  globalCard,
  projectCard,
  loadConfig,
  maintain,
  memoryStats,
  saveConfig,
  purposeState,
  savePurposeState,
  saveGlobalCard,
  saveProjectCard,
  moodState,
  resetMood,
  decayMoodFor
} from './store.js'
import { todayKey, runDiaryOnce } from './diary.js'
import { displayDims, moodFace, moodLabel, topDims, TIMELINE_CAP } from './mood.js'
import { forgetRecord, makeArchiver, setPinned, addRecord } from './memory.js'
import { closeGoal, openGoals, summarize } from './purpose.js'
import { MEMORY_FACTS } from './facts.js'
import { listWorkspaces, registerProject } from './registry.js'
import { getFallbackCwd } from './tool.js'

export const API_PREFIX = '/api/soul'

/**
 * 静态资源前缀：心情那五张表情图从这里出去（/dsh-agent-soul/face-ok.png）。
 * 跟 dsh-feiyu-mood 的老习惯一致，也避开宿主自己的路径。
 */
export const ASSET_PREFIX = '/dsh-agent-soul'

/** 只认这五张图 —— 白名单挡住 ../ 之类的路径穿越，别让外面翻目录。 */
const FACE_ASSETS = new Set([
  'face-great.png',
  'face-good.png',
  'face-ok.png',
  'face-worry.png',
  'face-sad.png'
])

/** 插件自己的 assets 目录（跟 lib/ 平级；npm 装完也在那儿）。 */
const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))

/** 请求体上限：设置页只传配置和短文本，1MB 足够，挡住手滑。 */
const MAX_BODY = 1024 * 1024

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error instanceof Error ? error.message : error}`))
      }
    })
    req.on('error', reject)
  })
}

const json = (res, code, payload) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * 弹一个系统「选择文件夹」对话框，返回选中的目录（取消返回空串）。
 *
 * 为什么要它：设置页里「项目人格」原本只能依赖宿主传 cwd，拿不到就整块灰死。
 * 浏览器拿不到原生目录选择器，所以这一步由宿主（Node 侧）代劳。
 * 三条平台分支各用系统自带工具，没有额外依赖。
 */
function pickFolder() {
  return new Promise((resolve, reject) => {
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
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', () => {
      resolve(out.trim())
    })
  })
}

/**
 * 会话服务里「最近活跃的那个会话」的工作目录（拿不到返回空串）。
 *
 * 设置页弹层是全局的，某些 DSH 版本不给 settings.section 传 sessionId，
 * 于是「当前工作目录」解析成空、面板直接死路。这里退一步：从会话服务里挑一个
 * 最近活跃且有 cwd 的会话兜底（页面会标明这是兜底值）。
 */
function recentSessionOf(ctx) {
  const sessions = serviceOf(ctx, 'sessions')
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return ''
  try {
    const list = sessions.list()
    if (!Array.isArray(list)) return ''
    let best = null
    for (const session of list) {
      const cwd = session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') continue
      const stamp = String(session?.header?.updatedAt ?? session?.header?.createdAt ?? session?.updatedAt ?? session?.createdAt ?? '')
      if (best === null || stamp > best.stamp) best = { stamp, cwd }
    }
    return best === null ? '' : best.cwd
  } catch {
    return ''
  }
}

/**
 * 接口取 cwd 的唯一入口：三级兜底。
 *
 * 2026-10-29 真事故：这套兜底原来**只写在 /state 里**，其它路由各自
 * `query.get('cwd') ?? ''` 就直接用。于是设置页拿不到会话 cwd 时：
 *
 *   概览 /state → 兜底到最近活跃会话 → 心情 80
 *   详情 /mood  → 拿到空串 → 落到 mood/global.json → 文件不存在 → 空白 70、七情全 0
 *
 * 同一个页面左边 80 右边 70，而且右边还显示「还没聊出变化」——
 * 看起来像心情功能整个坏了，其实是读了两份不同的文件。
 * 更糟的是 /mood/reset：用空 cwd 会把心情重置到一个从没用过的作用域上，
 * 页面还看不见自己刚才重置的那份。
 *
 * 三级的顺序不能改：页面手选 > 最近活跃会话 > 最近一次注入记下的。
 */
function resolveCwd(ctx, query) {
  const direct = String(query?.get?.('cwd') ?? '').trim()
  if (direct !== '') return { cwd: direct, source: 'path' }
  const recent = recentSessionOf(ctx)
  if (recent !== '') return { cwd: recent, source: 'recent' }
  const fallback = getFallbackCwd()
  // 标 fallback 而不是 recent：这两条来源不同（一个是会话服务里捞的，一个是注入时记下的），
  // 排查「设置页到底认了哪个目录」时混在一起会看不出走的哪条
  if (fallback !== '') return { cwd: fallback, source: 'fallback' }
  return { cwd: '', source: 'none' }
}

export function registerApi(ctx) {
  const webServer = serviceOf(ctx, 'webServer')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    note('api', '宿主没有 webServer 服务，设置页接口未注册')
    return undefined
  }

  const dispose = webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
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
            const host = String(req.headers.host ?? '')
            const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
            const samePort = parsed.port === String(host).split(':')[1]
            crossed = !(host !== '' && (parsed.host === host || (isLocal && samePort)))
          }
        } catch {
          crossed = true // Origin 都解析不了，不认
        }
        if (crossed) {
          note('api', `拒绝跨源请求：Origin=${origin} Host=${String(req.headers.host ?? '')}`)
          return json(res, 403, { ok: false, error: '跨源请求被拒绝' })
        }
      }

      const url = (req.url ?? '').split('?')[0]
      const route = url.slice(API_PREFIX.length) || '/'
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
      try {
        // ---- 人格文件：读 ----
        if (route === '/persona' && req.method === 'GET') {
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

        // ---- 人格文件：写 ----
        if (route === '/persona' && req.method === 'POST') {
          const body = await readBody(req)
          const kind = body?.kind === 'project' ? 'project' : 'global'
          const cwd = String(body?.cwd ?? '')
          const text = String(body?.text ?? '')
          if (kind === 'project' && cwd === '') {
            return json(res, 400, { ok: false, error: '写项目人格要给 cwd' })
          }
          if (text.length > MAX_INJECT_CHARS) {
            return json(res, 400, { ok: false, error: `太长（超过 ${MAX_INJECT_CHARS} 字），后面的内容不会生效` })
          }
          const file = kind === 'project' ? storedProjectPersonaPath(cwd) : globalPersonaPath()
          atomicWrite(file, text)
          note('api', `人格已保存（${kind}，${text.length} 字）→ ${file}`)
          return json(res, 200, { ok: true, path: file, chars: text.length })
        }

        // ---- 在系统文件管理器里选中人格文件 ----
        // 有些人就是想用 VS Code 改，别逼他在浏览器的 textarea 里写 Markdown。
        if (route === '/open' && req.method === 'POST') {
          const body = await readBody(req)
          const kind = body?.kind === 'project' ? 'project' : 'global'
          const cwd = String(body?.cwd ?? '')
          if (kind === 'project' && cwd === '') {
            return json(res, 400, { ok: false, error: '没有工作目录，不知道要打开哪一份' })
          }
          const file = kind === 'project' ? storedProjectPersonaPath(cwd) : globalPersonaPath()
          if (!exists(file)) {
            return json(res, 404, { ok: false, error: '这个文件还不存在 —— 先在编辑器里写点内容并保存，再打开' })
          }
          const platform = process.platform
          const cmd = platform === 'win32' ? 'explorer' : platform === 'darwin' ? 'open' : 'xdg-open'
          // Windows 的 explorer 用 `/select,` 选中文件；其它平台只能打开所在目录
          const args = platform === 'win32' ? ['/select,', file] : [dirname(file)]
          try {
            // detached + stdio ignore：explorer 不会自己退出，不能让它拖住进程
            spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
            note('api', `已在文件管理器中打开：${file}`)
            return json(res, 200, { ok: true, path: file })
          } catch (error) {
            return json(res, 500, { ok: false, error: `打开失败：${error instanceof Error ? error.message : error}` })
          }
        }

        // ---- 首屏：一次拿全 ----
        if (route === '/state' && req.method === 'GET') {
          // cwd 三级兜底（学 dsh-agent-md）：设置页是全局弹层，某些 DSH 版本
          // 不给 settings.section 传会话 cwd，光靠 query 会整块灰死。
          //   ① 页面显式传的（宿主 props 或用户手选） ② 最近活跃的会话 ③ 最近一次注入记下的
          // 三级兜底抽到 resolveCwd 里了 —— 这套逻辑以前只属于本路由，
          // /mood 那边没有，于是概览和详情读到了两份不同的心情文件
          const cwdPick = resolveCwd(ctx, query)
          const cwd = cwdPick.cwd
          const cwdSource = cwdPick.source
          // 设置页每 20 秒轮询一次 /state —— 不能每次都往 projects.json 写一遍：
          // 那会不停刷 lastSeen、改 active、重排顺序，纯属无谓写盘。
          // 只有「这个工作区还没登记过」才补登；切换 active 走 POST /register。
          if (cwd !== '') {
            const key = normalizePathKey(cwd)
            const known = listWorkspaces().some((item) => normalizePathKey(item?.cwd) === key)
            if (!known) registerProject(cwd, { active: true })
          }
          const config = loadConfig()
          const persona = composePersona({ cwd, config })
          const stats = memoryStats(cwd, config)
          const purpose = summarize(purposeState())

          // 位置标注（2026-10-28）：用户要看得见「这一份人格到底对哪个目录生效」。
          // 三层来源各自可能有、可能没有，光给一个路径说不清优先级 ——
          // 尤其是「cwd 里有 AGENT.md」时，它会**盖掉**设置页编辑的这份，
          // 不标出来就会出现「我在设置页改了却没生效」。
          const resolved = resolveSources({ cwd, config })
          const localFile = String(cwd).trim() !== '' ? localPersonaPath(cwd, config.localNames) : null
          const storedFile = String(cwd).trim() !== '' ? storedProjectPersonaPath(cwd) : ''
          const globalFile = globalPersonaPath()

          return json(res, 200, {
            ok: true,
            config,
            persona: {
              mode: persona.mode,
              sources: persona.sources,
              chars: persona.text.length,
              truncated: persona.truncated,
              preview: persona.text.slice(0, 400)
            },
            workspace: {
              cwd,
              cwdSource,
              slug: String(cwd).trim() !== '' ? slugFor(cwd).slug : '',
              // 三层来源，逐层标出存在与否 —— 页面按这个画优先级
              layers: [
                {
                  level: 1,
                  name: '项目内 AGENT.md',
                  scope: '跟着仓库走，可提交进 git',
                  path: localFile === null ? (String(cwd).trim() === '' ? '' : `${cwd}\\AGENT.md`) : localFile,
                  exists: localFile !== null,
                  editable: false
                },
                {
                  level: 2,
                  name: '项目人格（本机）',
                  scope: '这个工作区专用，设置页编辑的就是它',
                  path: storedFile,
                  exists: storedFile !== '' ? exists(storedFile) : false,
                  editable: storedFile !== ''
                },
                {
                  level: 3,
                  name: '全局人格',
                  scope: '所有会话的底座',
                  path: globalFile,
                  exists: exists(globalFile),
                  editable: true
                }
              ],
              // 项目层实际生效的是哪一份（1 优先于 2）
              projectEffective: resolved.project === null ? null : resolved.project.kind,
              projectEffectivePath: resolved.project === null ? '' : resolved.project.path,
              // cwd 里有 AGENT.md 时，设置页编辑的那份会被盖住 —— 必须提示
              localOverridesStored: localFile !== null && storedFile !== '' && exists(storedFile)
            },
            memory: stats,
            // 心情摘要：值 + 七情 + 最近理由（时间线走 /mood 拉全量）
            mood: (() => {
              const s = moodState(cwd)
              return {
                mood: Math.round(s.mood),
                label: moodLabel(s.mood),
                face: moodFace(s.mood),
                dims: displayDims(s),
                top: topDims(s),
                lastReason: s.lastReason,
                updatedAt: s.updatedAt,
                timelineCount: s.timeline.length
              }
            })(),
            // 本机所有工作区（DSH 工作区表 + 登记表 + 会话目录）：设置页的下拉用它
            workspaces: listWorkspaces(),
            purpose: { ...purpose, goals: openGoals(purposeState(), { limit: 10 }) },
            facts: MEMORY_FACTS,
            dirs: { log: 'agents/soul.log' }
          })
        }

        // ---- 保存配置 ----
        if (route === '/config' && req.method === 'POST') {
          const body = await readBody(req)
          const next = saveConfig(body?.config ?? body ?? {})
          note('api', `配置已保存：mode=${next.mode} 记忆预算=${next.injectMaxChars}`)
          return json(res, 200, { ok: true, config: next })
        }

        // ---- 列记忆 ----
        if (route === '/memory' && req.method === 'GET') {
          const scope = query.get('scope') === 'project' ? 'project' : 'global'
          // 列记忆也要跟着当前工作区走，否则「项目记忆」会永远显示空
          const { cwd } = resolveCwd(ctx, query)
          const keyword = (query.get('query') ?? '').trim().toLowerCase()
          const card = scope === 'project' && cwd !== '' ? projectCard(cwd) : globalCard()
          let records = [...card.records].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
          if (keyword !== '') {
            records = records.filter((record) => `${record.text} ${record.title}`.toLowerCase().includes(keyword))
          }
          return json(res, 200, {
            ok: true,
            scope,
            total: card.records.length,
            lastDecayDate: card.lastDecayDate,
            records: records.slice(0, 300).map((record) => ({
              id: record.id,
              text: record.text,
              title: record.title,
              importance: record.importance,
              clarity: record.clarity,
              tags: record.tags,
              pinned: record.pinned,
              createdAt: record.createdAt,
              lastSeenAt: record.lastSeenAt,
              recallCount: record.recallCount,
              source: record.source
            }))
          })
        }

        // ---- 增 / 改 / 删一条记忆 ----
        if (route === '/memory' && req.method === 'POST') {
          const body = await readBody(req)
          const scope = body?.scope === 'project' ? 'project' : 'global'
          // 必须和 GET /memory 用同一套兜底。
          // 原来这里直接 String(body?.cwd ?? '')：设置页拿不到会话 cwd 时，
          // 列表走兜底读到项目卡、显示得出来，删除却按空 cwd 去查全局卡 ——
          // 全局卡是空的，于是永远「没找到这条记忆」。删 / 固定 / 编辑都一样。
          const given = String(body?.cwd ?? '').trim()
          const cwd = given !== '' ? given : resolveCwd(ctx, query).cwd
          const card = scope === 'project' && cwd !== '' ? projectCard(cwd) : globalCard()
          const action = String(body?.action ?? '')
          const id = String(body?.id ?? '')

          if (action === 'delete') {
            // 传 archive：设置页点删除也算「遗忘」，要能在 archive.jsonl 里查回来
            const removed = forgetRecord(card, id, makeArchiver(archivePath()))
            if (removed === null) {
              note('api', `删除落空：scope=${scope} cwd=「${cwd}」卡里 ${card.records.length} 条，找不到 id=${id}`)
              return json(res, 404, { ok: false, error: '没找到这条记忆' })
            }
          } else if (action === 'pin') {
            if (!setPinned(card, id, body?.pinned !== false)) {
              note('api', `固定落空：scope=${scope} cwd=「${cwd}」卡里 ${card.records.length} 条，找不到 id=${id}`)
              return json(res, 404, { ok: false, error: '没找到这条记忆' })
            }
          } else if (action === 'write') {
            // 设置页手动新增。走 addRecord 才能拿到打分、去重、脱敏那一套。
            const text = String(body?.text ?? '').trim()
            if (text === '') return json(res, 400, { ok: false, error: '内容不能为空' })
            const result = addRecord(card, { text, source: 'manual', isOwner: true, isPrivate: true }, loadConfig(), Date.now())
            if (result.ok !== true) return json(res, 400, { ok: false, error: result.reason ?? '写入失败' })
          } else if (action === 'edit') {
            const record = card.records.find((item) => item.id === id)
            if (record === undefined) return json(res, 404, { ok: false, error: '没找到这条记忆' })
            if (typeof body?.text === 'string' && body.text.trim() !== '') record.text = body.text.trim().slice(0, 600)
            if (typeof body?.title === 'string') record.title = body.title.trim().slice(0, 60)
          } else {
            return json(res, 400, { ok: false, error: `不认识的 action：${action}` })
          }

          if (scope === 'project' && cwd !== '') saveProjectCard(cwd, card)
          else saveGlobalCard(card)
          return json(res, 200, { ok: true, total: card.records.length })
        }

        // ---- 手动维护 ----
        if (route === '/maintain' && req.method === 'POST') {
          const body = await readBody(req)
          const given = String(body?.cwd ?? '').trim()
          const cwd = given !== '' ? given : resolveCwd(ctx, query).cwd
          const report = maintain(cwd, loadConfig())
          return json(res, 200, { ok: true, report })
        }

        // ---- 心情：读全量（值 + 七情 + 时间线） ----
        if (route === '/mood' && req.method === 'GET') {
          // 必须和 /state 用同一套兜底，否则详情页和概览页读的是两份文件
          const { cwd } = resolveCwd(ctx, query)
          const cfg = loadConfig()
          const s = moodState(cwd)
          return json(res, 200, {
            ok: true,
            cwd,
            config: cfg,
            state: {
              mood: Math.round(s.mood),
              rawMood: s.mood,
              label: moodLabel(s.mood),
              face: moodFace(s.mood),
              dims: displayDims(s),
              top: topDims(s),
              lastReason: s.lastReason,
              lastConfidence: s.lastConfidence,
              minor: s.minor,
              kind: s.kind,
              updatedAt: s.updatedAt,
              timelineCount: s.timeline.length,
              // 时间线倒序 60 条（页面再截 40）；t.dims 也一并给，方便 tooltip
              timeline: s.timeline.slice(-60).reverse().map((t) => ({
                at: t.at,
                mood: t.mood,
                delta: t.delta,
                reason: t.reason,
                conf: t.conf,
                minor: t.minor === true,
                kind: t.kind || '',
                dims: t.dims || null
              }))
            }
          })
        }

        // ---- 心情：重置 ----
        if (route === '/mood/reset' && req.method === 'POST') {
          const body = await readBody(req)
          const given = String(body?.cwd ?? '').trim()
          // 页面没给 cwd 就按当前工作区兜底：不然会把心情重置到一个从没用过的作用域上，
          // 页面还看不见自己刚重置的那份（表现为「点了重置却没反应」）
          const cwd = given !== '' ? given : resolveCwd(ctx, query).cwd
          const s = resetMood(cwd)
          note('api', `心情已重置（cwd=${cwd || '全局'}）→ ${Math.round(s.mood)}`)
          return json(res, 200, { ok: true, mood: Math.round(s.mood) })
        }

        // ---- 心情：手动跑一次时间衰减（页面刷新时用，幂等） ----
        if (route === '/mood/decay' && req.method === 'POST') {
          const body = await readBody(req)
          const given = String(body?.cwd ?? '').trim()
          const cwd = given !== '' ? given : resolveCwd(ctx, query).cwd
          const s = decayMoodFor(cwd)
          return json(res, 200, {
            ok: true,
            mood: Math.round(s.mood),
            dims: displayDims(s),
            lastReason: s.lastReason,
            updatedAt: s.updatedAt
          })
        }

        // ---- 目标：关掉一条 ----
        if (route === '/goal' && req.method === 'POST') {
          const body = await readBody(req)
          const state = purposeState()
          const id = String(body?.id ?? '')
          const ok = closeGoal(state, id)
          if (ok) savePurposeState(state)
          return json(res, ok ? 200 : 404, { ok, goals: openGoals(state, { limit: 20 }) })
        }

        // ---- 登记工作区（设置页「使用」按钮：手填/选中的目录切过去） ----
        if (route === '/register' && req.method === 'POST') {
          const body = await readBody(req)
          const cwd = String(body?.cwd ?? '').trim()
          if (cwd === '') return json(res, 400, { ok: false, error: '缺少 cwd' })
          const registry = registerProject(cwd, { active: body.active === true })
          return json(res, 200, { ok: true, registry, slug: slugFor(cwd).slug })
        }

        // ---- 系统「选择文件夹」：让任意目录都能成为项目人格的归属 ----
        if (route === '/pick' && req.method === 'POST') {
          try {
            const picked = await pickFolder()
            if (picked === '') return json(res, 200, { picked: '', cancelled: true })
            registerProject(picked, { active: false })
            return json(res, 200, { picked, cancelled: false, slug: slugFor(picked).slug })
          } catch (error) {
            return json(res, 500, {
              ok: false,
              error: `打不开系统文件夹选择器：${error instanceof Error ? error.message : error}；可以直接把路径粘到输入框里。`
            })
          }
        }

        // ---- 日记：列表（只列公开日记的预览；私密内容不出服务器） ----
        if (route === '/diary/list' && req.method === 'GET') {
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
              preview: hasPublic ? readText(publicFile).slice(0, 400) : '',
              updatedAt: hasPublic ? statSync(publicFile).mtime.toISOString() : null
            })
          }
          return json(res, 200, { ok: true, list })
        }

        // ---- 日记：读取某一天（私密不出服务器，只返回存在性） ----
        if (route === '/diary/read' && req.method === 'GET') {
          const dateStr = String(query.get('date') ?? '').trim()
          if (dateStr === '') return json(res, 400, { ok: false, error: '缺少 date 参数' })
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

        // ---- 手动触发日记 ----
        if (route === '/diary' && req.method === 'POST') {
          const body = await readBody(req)
          const dateStr = String(body?.date ?? '').trim() || todayKey(Date.now())
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

        return json(res, 404, { ok: false, error: `不认识的路由：${route}` })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        note('api', `${route} 出错：${message}`)
        return json(res, 500, { ok: false, error: message })
      }
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
      const url = (req.url ?? '').split('?')[0]
      const raw = url.slice(ASSET_PREFIX.length).replace(/^\/+/, '')
      const name = decodeURIComponent(raw)
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
  })
  if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-agent-soul: assets')
  }
  note('api', `表情图已注册 ${ASSET_PREFIX}（${FACE_ASSETS.size} 张）`)
  return dispose
}
