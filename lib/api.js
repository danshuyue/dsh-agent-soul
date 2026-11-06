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
 *   GET  /diary/private  读私密正文（2026-10-31；仅回环 + diaryPrivateVisible=true）
 *   GET  /diary/sessions 可选会话列表（设置页的日记会话下拉用，最多 50 条）
 *   POST /diary/bind     把会话绑定成日记会话（{ sessionId? }，缺省取当前会话）
 *   POST /diary/unbind   清除日记会话绑定
 */
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archivedSessionIds } from './archive.js'
import {
  SESSION_ROUTE,
  TOKEN_HEADER,
  checkApiRateLimit,
  checkSessionRateLimit,
  issueSessionToken,
  verifyApiToken
} from './api-token.js'
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
  diaryPrivatePath,
  isDiaryDateKey
} from './paths.js'
import { hostProbeState } from './host.js'
import { deleteSecret, saveSecret, secretInfo } from './secrets.js'
import {
  // 2026-11-04：/config 的键白名单要用它（只允许写入声明过的配置项）
  DEFAULT_CONFIG,
  globalCard,
  projectCard,
  loadConfig,
  maintain,
  memoryHealth,
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
import { todayKey, yesterdayKey, runDiaryOnce } from './diary.js'
import { displayDimPercents, displayDims, moodFace, moodLabel, topDims, TIMELINE_CAP } from './mood.js'
import { forgetRecord, makeArchiver, setPinned, addRecord } from './memory.js'
import { closeGoal, openGoals, summarize } from './purpose.js'
import { MEMORY_FACTS } from './facts.js'
import { decodeSessionDirName, listWorkspaces, registerProject, sessionsRoot } from './registry.js'
import { EMPTY_SESSION_TITLE, titleForSession } from './session-title.js'
import { deleteNote, listNotes, readNote, renameNote, writeNote } from './notes.js'
import { getFallbackCwd } from './tool.js'
import { attestationState } from './attest.js'

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
 * 请求是不是从本机回环地址发来的（2026-10-31）。
 *
 * 为什么单独判一次：私密日记正文默认永不出服务器。开了 diaryPrivateVisible
 * 也只给「这台机器上的自己」看 —— 远程访问（局域网 / 反代）拿到的应当仍是 403。
 * remoteAddress 的三种写法都要认：IPv4 直连、IPv6 回环、IPv4-mapped IPv6。
 */
export function isLoopbackRequest(req) {
  const remote = String(req?.socket?.remoteAddress ?? '')
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/**
 * 是否放行这次接口请求（2026-11-04 修 ⑤，纯函数便于测试）。
 *
 * 原来的权限模型是**反的**：最敏感的私密日记（/diary/private）做了回环校验，
 * 而「改写注入内容的人格」「覆盖笔记」「弹系统文件对话框」这些更危险的动作，
 * 只要请求不带 Origin 就一律放行 —— 本机任何进程（脚本、别的应用、浏览器扩展）
 * 都能直接 POST 过来。
 *
 * 现在统一：只认本机回环。设置页本来就是从 127.0.0.1 访问的，不受影响。
 *
 * 留 `apiLoopbackOnly: false` 这一个逃生口：万一某些宿主的 webServer 走的是
 * 转发/代理、remoteAddress 不是回环地址，用户能改配置自救，而不是被锁在门外
 * 又找不到原因（被拒的请求会打日志，含真实 remoteAddress）。
 */
export function shouldAllowApiRequest(req, config) {
  if (config !== null && config !== undefined && config.apiLoopbackOnly === false) return true
  return isLoopbackRequest(req)
}

/** 配置值校验的边界（2026-11-06 修 R6）。 */
const CONFIG_STRING_MAX = 4096
/** 纯文件名：不含分隔符与 Windows 保留字符，长度 1~64。 */
const CONFIG_NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,64}$/

/**
 * 校验单个配置值（2026-11-06 修 R6，纯函数便于测试）。
 *
 * 为什么需要它：`/config` 原来只过滤键名，值是原样写进去的。写进一个对象、NaN 或负数，
 * 归一化时要么被吞成 undefined，要么传染整块配置 —— 表现是「提示保存成功、某功能静默失效」。
 *
 * 刻意**不设数值上限**：`diarySessionBornAt` 是毫秒时间戳（≈1.79e12），
 * 拍一个 1e9 之类的上限会让绑过日记会话的用户永远存不了设置。
 * 只拒绝「明显不可能是配置」的值：非有限数、负数、null、对象、控制字符、超长字符串。
 *
 * @param {string} key 已通过键白名单的配置名
 * @param {unknown} value 客户端提交的值
 * @returns {{ok: true, value: unknown} | {ok: false, error: string}}
 */
export function validateConfigEntry(key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) return { ok: false, error: '未知配置项' }
  const fallback = DEFAULT_CONFIG[key]
  if (value === undefined) return { ok: false, error: '值是 undefined' }

  if (typeof fallback === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value }
    if (value === 'true' || value === '1') return { ok: true, value: true }
    if (value === 'false' || value === '0') return { ok: true, value: false }
    return { ok: false, error: '应为 true/false' }
  }

  if (typeof fallback === 'number') {
    if (typeof value !== 'number') return { ok: false, error: '应为数字' }
    if (!Number.isFinite(value)) return { ok: false, error: '不是有限数字（NaN/Infinity）' }
    if (value < 0) return { ok: false, error: '不能为负数' }
    return { ok: true, value }
  }

  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) return { ok: false, error: '应为字符串数组' }
    if (value.length > 64) return { ok: false, error: '数组元素过多（上限 64）' }
    const out = []
    for (const item of value) {
      if (typeof item !== 'string') return { ok: false, error: '数组元素应为字符串' }
      if (item === '.' || item === '..' || !CONFIG_NAME_RE.test(item)) {
        return { ok: false, error: '数组元素只能是纯文件名（不能带路径分隔符或 ..）' }
      }
      out.push(item)
    }
    return { ok: true, value: out }
  }

  if (typeof fallback === 'string') {
    if (typeof value !== 'string') return { ok: false, error: '应为字符串' }
    if (value.length > CONFIG_STRING_MAX) return { ok: false, error: `超过 ${CONFIG_STRING_MAX} 字上限` }
    // 允许换行/制表（语气、人设这类多行文本），其余控制字符一律拒绝
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return { ok: false, error: '含控制字符' }
    return { ok: true, value }
  }

  // 默认值为 null 或类型未知：只放行标量，别让对象混进来
  if (value === null) return { ok: true, value: null }
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return { ok: true, value }
  return { ok: false, error: '值类型不支持' }
}

/**
 * 私密日记的访问闸门 + 读取（2026-10-31，纯函数便于测试）。
 *
 * 顺序不能换：先判回环，再判开关，最后才读文件 —— 开关关着时连「文件在不在」
 * 之外的任何内容都不回。鉴权沿用 /api/soul 全局那道 Origin 跨源检查（POST /diary
 * 用的也是它），这里再加一层回环限制，是私密内容的第二道锁。
 *
 * @returns {{ status: number, payload: object }}
 */
export function privateDiaryView(req, config) {
  if (!isLoopbackRequest(req)) {
    return { status: 403, payload: { ok: false, error: '私密日记只允许本机回环请求' } }
  }
  if (config === null || config === undefined || config.diaryPrivateVisible !== true) {
    return { status: 403, payload: { ok: false, error: '私密日记查看未开启（diaryPrivateVisible=false）' } }
  }
  let dateStr = ''
  try {
    dateStr = String(new URL(req?.url ?? '/', 'http://127.0.0.1').searchParams.get('date') ?? '').trim()
  } catch {
    dateStr = ''
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { status: 400, payload: { ok: false, error: '缺少或非法的 date 参数（YYYY-MM-DD）' } }
  }
  const file = diaryPrivatePath(dateStr)
  const hasPrivate = exists(file)
  return {
    status: 200,
    payload: { ok: true, date: dateStr, hasPrivate, content: hasPrivate ? readText(file) : '' }
  }
}

/**
 * 会话服务里最近更新的会话 id（拿不到返回空串）。
 *
 * 2026-10-31：这台 DSH 的设置页 renderSlot('settings.section') 只传 { close }，
 * 前端拿不到当前会话 id。点「把当前会话指定为日记会话」时请求里就没 id，
 * 这里按 updatedAt 取「最近动过的那个」当当前会话 —— 只用于【手动绑定这一步】；
 * 投递侧只认配置里的 id，绝不回退到这里。
 */
function currentSessionIdOf(ctx) {
  const sessions = serviceOf(ctx, 'sessions')
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return ''
  try {
    const list = sessions.list()
    if (!Array.isArray(list)) return ''
    let best = null
    for (const session of list) {
      const id = String(session?.header?.id ?? session?.id ?? '')
      if (id === '') continue
      const stamp = String(session?.header?.updatedAt ?? session?.header?.createdAt ?? session?.updatedAt ?? session?.createdAt ?? '')
      if (best === null || stamp > best.stamp) best = { id, stamp }
    }
    return best === null ? '' : best.id
  } catch {
    return ''
  }
}

/**
 * 日记设置页的会话候选（2026-11-04）。
 *
 * 主来源是 sessions 服务（只含活着的会话，但标题最准）；拿不到或一条都没有时，
 * 扫 sessionsRoot() 兜底 —— 至少让下拉里有 id 可选。任何一步失败都只记日志，
 * 绝不把异常抛给路由（接口约定：失败也返回 200 + 空数组）。
 *
 * 2026-11-04：两个来源都要滤掉归档会话。扫盘只认目录、完全不认归档；sessions
 * 服务也可能把归档的列出来。归档集合读不到时 archivedSessionIds() 返回空集合
 * （等于不过滤）并记一行日志，绝不因此让下拉变成空的。
 *
 * 2026-11-04（第二次改）：标题不再直接信 header —— 会话标题落在日志的
 * `session/title` 事件里（header.title 常常是 id 或空）。优先级改为：
 *   sessionTitle 服务 → 日志里的标题（见 lib/session-title.js）→ header.title
 *   → （空会话，没有消息）
 * 读日志有磁盘 IO，只对最终入选的 ≤50 条做；每条单独 try/catch，一条坏日志
 * 只丢它自己的标题，不拖垮整个列表。
 *
 * @returns {Array<{id:string,title:string,cwd:string,updatedAt:string}>}
 */
function listDiarySessions(ctx) {
  const byId = new Map()
  // 只取一次，两个来源共用；取不到时是空集合，put 里的判断自然全部放行
  const archived = archivedSessionIds()

  const put = (raw) => {
    const id = String(raw?.id ?? '').trim()
    if (id === '') return
    // 归档会话不进下拉（用户收起来的，不该被绑成日记会话）
    if (archived.has(id)) return
    const title = String(raw?.title ?? '').trim()
    const headerTitle = String(raw?.headerTitle ?? '').trim()
    const cwd = String(raw?.cwd ?? '')
    const updatedAt = String(raw?.updatedAt ?? '')
    const old = byId.get(id)
    if (old === undefined) {
      byId.set(id, { id, title, headerTitle, cwd, updatedAt })
      return
    }
    // 同一个会话可能来自多个来源：标题留非空的，cwd 留非空的，时间留新的
    if (old.title === '' && title !== '') old.title = title
    if (old.headerTitle === '' && headerTitle !== '') old.headerTitle = headerTitle
    if (old.cwd === '' && cwd !== '') old.cwd = cwd
    if (updatedAt > old.updatedAt) old.updatedAt = updatedAt
  }

  try {
    const sessions = serviceOf(ctx, 'sessions')
    if (sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
      // 标题在 sessionTitle 服务里；它不一定会出现在 inject 里，每次访问都兜住
      let titleSvc
      try {
        titleSvc = serviceOf(ctx, 'sessionTitle')
      } catch (error) {
        note('api', `日记会话列表：sessionTitle 不可用（${error instanceof Error ? error.message : error}）`)
        titleSvc = undefined
      }
      for (const session of sessions.list() ?? []) {
        const header = session?.header ?? {}
        const id = String(header.id ?? session?.id ?? '').trim()
        if (id === '') continue
        let title = ''
        if (titleSvc !== undefined && titleSvc !== null && typeof titleSvc.get === 'function') {
          try {
            const folded = titleSvc.get(session)
            if (typeof folded === 'string') title = folded
          } catch (error) {
            note('api', `日记会话列表：读标题失败 ${id}（${error instanceof Error ? error.message : error}）`)
          }
        }
        put({
          id,
          title,
          headerTitle: String(session?.displayTitle ?? header.displayTitle ?? session?.title ?? header.title ?? ''),
          cwd: String(header.cwd ?? session?.cwd ?? ''),
          updatedAt: String(header.updatedAt ?? header.createdAt ?? session?.updatedAt ?? session?.createdAt ?? '')
        })
      }
    } else {
      note('api', '日记会话列表：sessions 服务不可用，改用扫盘兜底')
    }
  } catch (error) {
    note('api', `日记会话列表：sessions.list 失败（${error instanceof Error ? error.message : error}）`)
  }

  // 服务挂了 / 一个活会话都没有时扫盘。只扫两层：<sessions>/<编码后的 cwd>/<会话 id>/
  if (byId.size === 0) {
    let cwdDirs = []
    try {
      cwdDirs = readdirSync(sessionsRoot(), { withFileTypes: true })
    } catch (error) {
      note('api', `日记会话列表：扫盘失败 ${sessionsRoot()}（${error instanceof Error ? error.message : error}）`)
    }
    for (const cwdDir of cwdDirs) {
      if (cwdDir.isDirectory() !== true) continue
      const cwd = decodeSessionDirName(cwdDir.name)
      let sessionDirs = []
      try {
        sessionDirs = readdirSync(join(sessionsRoot(), cwdDir.name), { withFileTypes: true })
      } catch (error) {
        note('api', `日记会话列表：跳过 ${cwdDir.name}（${error instanceof Error ? error.message : error}）`)
        continue
      }
      for (const sessionDir of sessionDirs) {
        if (sessionDir.isDirectory() !== true) continue
        let updatedAt = ''
        try {
          updatedAt = statSync(join(sessionsRoot(), cwdDir.name, sessionDir.name)).mtime.toISOString()
        } catch {
          /* 读不到时间就留空 */
        }
        put({ id: sessionDir.name, title: '', cwd, updatedAt })
      }
    }
  }

  const picked = [...byId.values()]
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt)
      const tb = Date.parse(b.updatedAt)
      const va = Number.isFinite(ta) ? ta : 0
      const vb = Number.isFinite(tb) ? tb : 0
      if (va !== vb) return vb - va
      return a.id.localeCompare(b.id)
    })
    .slice(0, 50)

  // 只有这里开始读磁盘，而且只读最终入选的这 ≤50 条。
  // 每条独立 try/catch：一条日志坏掉只丢它自己的标题，列表照常返回。
  for (const item of picked) {
    if (item.title === '') {
      try {
        const fromLog = titleForSession(item.id)
        if (typeof fromLog === 'string' && fromLog !== '') item.title = fromLog
      } catch (error) {
        note('api', `日记会话列表：读日志标题失败 ${item.id}（${error instanceof Error ? error.message : error}）`)
      }
    }
    if (item.title === '') item.title = item.headerTitle
    if (item.title === '') item.title = EMPTY_SESSION_TITLE
    // headerTitle 只是中间产物，不往外带
    delete item.headerTitle
  }

  return picked
}

/**
 * 日记本用了几天（绑定当天算第 1 天；绑定时间缺失时返回 0，页面据此不显示）。
 * 按 24 小时向上取整：用了 1 小时算 1 天，满 15×24 小时显示 15 天。
 */
function diarySessionDays(bornAt, now = Date.now()) {
  const born = Number(bornAt)
  if (!Number.isFinite(born) || born <= 0) return 0
  const elapsed = Math.max(0, Number(now) - born)
  return Math.max(1, Math.ceil(elapsed / (24 * 60 * 60 * 1000)))
}

/**
 * 弹一个系统「选择文件夹」对话框，返回选中的目录（取消返回空串）。
 *
 * 为什么要它：设置页里「项目人格」原本只能依赖宿主传 cwd，拿不到就整块灰死。
 * 浏览器拿不到原生目录选择器，所以这一步由宿主（Node 侧）代劳。
 * 三条平台分支各用系统自带工具，没有额外依赖。
 */
/** 系统对话框没人关时，Promise 原本永不 settle（P2-12）。 */
const PICK_TIMEOUT_MS = 60_000
let pickInFlight = false

function pickFolder() {
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
      child = spawn(cmd, args, { windowsHide: true })
    } catch (error) {
      finish(reject, error)
      return
    }
    timer = setTimeout(() => {
      try { child?.kill() } catch { /* 已经退出了 */ }
      finish(reject, new Error(`选择文件夹超时（${PICK_TIMEOUT_MS / 1000} 秒），已关闭对话框`))
    }, PICK_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    let out = ''
    child.stdout?.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('error', (error) => finish(reject, error))
    child.on('exit', () => finish(resolve, out.trim()))
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
      // 纯插件侧没有可信注入通道，见 lib/api-token.js 文件头与报告 11.6。
      if (route === SESSION_ROUTE && req.method === 'GET') {
        if (!checkSessionRateLimit(req)) {
          return json(res, 429, { ok: false, error: '令牌发放过于频繁，稍后再试' })
        }
        const issued = issueSessionToken(req)
        if (issued.ok !== true) return json(res, issued.status, { ok: false, error: issued.error })
        return json(res, 200, { ok: true, token: issued.token })
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
        if (route === '/attestation' && req.method === 'GET') {
          return json(res, 200, { ok: true, ...attestationState() })
        }

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
            // 2026-11-06 修 R16：detached spawn 的 'error' 是**异步 emit** 的，
            // 没有监听器时 EventEmitter 会抛成未捕获异常 —— 直接带掉整个宿主进程。
            // try/catch 只接得住同步失败（比如参数非法），接不住它。
            const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
            child.on('error', (error) => note('api', `打开文件管理器失败：${error instanceof Error ? error.message : error}`))
            child.unref()
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
            // health：上次读取记忆卡有没有出事（损坏备份 / 只读）。
            // 数据出了问题是**必须看得见**的 —— 只在 soul.log 里留一行等于没留。
            memory: { ...stats, health: memoryHealth() },
            // 宿主形状自检：宿主升级把事件形状改了的话，这里会留下现场
            host: hostProbeState(),
            // 心情摘要：值 + 七情 + 最近理由（时间线走 /mood 拉全量）
            mood: (() => {
              const s = moodState(cwd)
              return {
                mood: Math.round(s.mood),
                label: moodLabel(s.mood),
                face: moodFace(s.mood),
                dims: displayDims(s),
                dimsPercent: displayDimPercents(s),
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
            dirs: { log: 'agents/soul.log' },
            // 2026-10-31：概览页「最近」那张卡要看昨天那篇写没写。
            // 只报状态，不读正文 —— 私密那篇的正文不该出现在概览里。
            diary: (() => {
              const y = yesterdayKey(Date.now())
              const t = todayKey(Date.now())
              // 没绑定会话时即使旧配置里留着 bornAt，也不该在概览上显示「日记本 N 天」
              const bound = String(config.diarySessionId ?? '').trim() !== ''
              const bornAt = bound ? Number(config.diarySessionBornAt) || 0 : 0
              return {
                today: t,
                yesterday: y,
                yesterdayPublic: exists(diaryPublicPath(y)),
                yesterdayPrivate: exists(diaryPrivatePath(y)),
                // 两篇都算写完才算「已写」
                yesterdayDone: exists(diaryPublicPath(y)) && exists(diaryPrivatePath(y)),
                // 日记本用了几天：概览页「最近」那张卡的小药丸用它
                sessionBornAt: bornAt,
                sessionDays: diarySessionDays(bornAt)
              }
            })()
          })
        }

        // ---- 保存配置 ----
        if (route === '/config' && req.method === 'POST') {
          const body = await readBody(req)
          // 2026-11-04 修 B8：加键白名单。
          //
          // 原来是 saveConfig(body.config ?? body) 全量合并 —— 一次请求就能写
          // 任何键。现在只接受 DEFAULT_CONFIG 里声明过的键，未知键一律丢弃。
          //
          // 2026-11-05 修 P0-1（止血）：白名单本身挡不住「边界开关」——
          // apiLoopbackOnly 是 DEFAULT_CONFIG 的合法键，设置页也确实有控件
          // （旧注释说「没有控件」是过期信息）。它一旦被写成 false，接口就对
          // 非回环来源敞开，等于一次请求把唯一的权限边界持久化关掉。
          // 这里不删控件：宿主走反向代理时确实需要自救（见 DEFAULT_CONFIG 注释），
          // 改成「必须在启动环境显式声明 DSH_SOUL_ALLOW_REMOTE_API=1」才允许放宽。
          // 完整 token 鉴权属下一批，别把这一步当成鉴权的替代。
          const incoming = body?.config ?? body ?? {}
          const allowed = new Set(Object.keys(DEFAULT_CONFIG))
          const allowRelaxLoopback = process.env.DSH_SOUL_ALLOW_REMOTE_API === '1'
          const filtered = {}
          const rejected = []
          const invalid = []
          for (const [key, value] of Object.entries(incoming ?? {})) {
            if (!allowed.has(key)) {
              rejected.push(key)
              continue
            }
            if (key === 'apiLoopbackOnly' && value === false && !allowRelaxLoopback) {
              note('api', '拒绝通过接口关闭回环限制（需 DSH_SOUL_ALLOW_REMOTE_API=1）')
              return json(res, 400, {
                ok: false,
                error: '关闭「只允许本机访问」需在启动环境设置 DSH_SOUL_ALLOW_REMOTE_API=1；HTTP 接口不能直接放宽此边界'
              })
            }
            // 2026-11-06 修 R6：白名单只挡键名，不挡值。
            // 之前把对象 / NaN / 负数写进去，经过 normalize 会变成 undefined 或传染整块配置，
            // 表现是「设置页显示保存成功、实际某个功能静默失效」。
            const check = validateConfigEntry(key, value)
            if (check.ok !== true) {
              invalid.push(`${key}（${check.error}）`)
              continue
            }
            filtered[key] = check.value
          }
          if (invalid.length > 0) {
            note('api', `配置有非法值，已拒绝：${invalid.join('、')}`)
            return json(res, 400, { ok: false, error: `配置值不合法：${invalid.join('、')}` })
          }
          if (rejected.length > 0) {
            note('api', `配置写入了未知键，已忽略：${rejected.join('、')}`)
          }
          const next = saveConfig(filtered)
          note('api', `配置已保存：mode=${next.mode} 记忆预算=${next.injectMaxChars} 相关区=${next.memoryRecall !== false ? `开(${next.memoryRecallTopK ?? 6})` : '关'}`)
          return json(res, 200, { ok: true, config: next })
        }

        // ---- 存密钥（只进不出：返回的永远只是状态，不回显明文）----
        if (route === '/secret' && req.method === 'POST') {
          const body = await readBody(req)
          const name = String(body?.name ?? '').trim()
          const value = String(body?.value ?? '')
          // 2026-11-05 S3 / P2-19：name 原来直接进日志（可注入换行伪造日志行），
          // value 没有任何长度上限（1MB body 全塞进密钥文件）。
          const safeName = name.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 48) || '（空）'
          if (body?.remove === true) {
            const removed = deleteSecret(name)
            note('api', `密钥 ${safeName} 已删除`)
            return json(res, 200, { ok: true, removed, status: secretInfo(name) })
          }
          if (value.length > 8192) {
            return json(res, 400, { ok: false, error: '密钥内容超过 8192 字符上限' })
          }
          // 会话令牌由启动环境/内存管理，不允许 HTTP 侧覆盖同名密钥。
          if (name === 'soul_api_token') {
            return json(res, 400, { ok: false, error: '该名称保留给接口会话令牌，不能通过 HTTP 写入' })
          }
          const saved = saveSecret(name, value)
          if (saved.ok !== true) return json(res, 400, { ok: false, error: saved.error })
          note('api', `密钥 ${safeName} 已保存（${saved.encrypted ? 'DPAPI 加密' : '明文+0600'}）`)
          return json(res, 200, { ok: true, encrypted: saved.encrypted, status: secretInfo(name) })
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

          // 2026-11-05 修 P0-4：设置页原来忽略保存结果，删/改/新增写盘失败也回 200。
          const saved = scope === 'project' && cwd !== '' ? saveProjectCard(cwd, card) : saveGlobalCard(card)
          if (saved?.ok !== true) {
            return json(res, 500, { ok: false, error: `记忆保存失败：${saved?.error ?? '未知原因'}` })
          }
          return json(res, 200, { ok: true, total: card.records.length })
        }

        // ---- 手动维护 ----
        if (route === '/maintain' && req.method === 'POST') {
          const body = await readBody(req)
          const given = String(body?.cwd ?? '').trim()
          const cwd = given !== '' ? given : resolveCwd(ctx, query).cwd
          const report = maintain(cwd, loadConfig())
          // 2026-11-05 修 P0-4：维护里任何一次卡写盘失败都要让这次请求失败，
          // 否则前端看到的仍是「维护完成」，实际衰减/压缩根本没落盘。
          if (Array.isArray(report.errors) && report.errors.length > 0) {
            return json(res, 500, { ok: false, error: '维护写盘失败', report })
          }
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
            // 密钥只报状态，绝不回显明文（2026-11-01）
            secrets: { siliconflow: secretInfo('siliconflow') },
            state: {
              mood: Math.round(s.mood),
              rawMood: s.mood,
              label: moodLabel(s.mood),
              face: moodFace(s.mood),
              dims: displayDims(s),
              dimsPercent: displayDimPercents(s),
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
            dimsPercent: displayDimPercents(s),
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
          if (!ok) return json(res, 404, { ok: false, goals: openGoals(state, { limit: 20 }) })
          // 2026-11-05：写盘失败必须回 500，不能让设置页显示「已放下」却没落盘。
          const saved = savePurposeState(state)
          if (saved.ok !== true) return json(res, 500, { ok: false, error: saved.error })
          return json(res, 200, { ok: true, goals: openGoals(state, { limit: 20 }) })
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

        // ---- 日记：读私密正文（2026-10-31；仅回环 + 显式开启） ----
        // 默认 diaryPrivateVisible=false 时这里一律 403，行为和以前一样：
        // 私密只报存在性，正文永不出服务器。开关打开也只对本机回环放行。
        if (route === '/diary/private' && req.method === 'GET') {
          const view = privateDiaryView(req, loadConfig())
          return json(res, view.status, view.payload)
        }

        // ---- 日记：可选会话（2026-11-04） ----
        // 设置页的下拉要能看到「任意会话」，不只是当前这个。列表失败不报 500：
        // 返回空数组，页面仍有「刷新列表」按钮可以重试。
        if (route === '/diary/sessions' && req.method === 'GET') {
          let sessions = []
          try {
            sessions = listDiarySessions(ctx)
          } catch (error) {
            note('api', `日记会话列表生成失败：${error instanceof Error ? error.message : error}`)
          }
          return json(res, 200, { ok: true, sessions })
        }

        // ---- 日记：绑定当前会话 / 清除绑定（2026-10-31） ----
        // 为什么绑：agents.create 造出来的日记会话没有宿主的标准工具集，写不出文件。
        // 只接受明确的会话 id；请求没带就取「最近更新的会话」（这台 DSH 的设置页
        // 拿不到 sessionId，见 currentSessionIdOf 的注释）。
        if (route === '/diary/bind' && req.method === 'POST') {
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
          try {
            const agents = serviceOf(ctx, 'agents')
            if (agents === undefined || agents === null || typeof agents.get !== 'function') {
              note('api', `日记会话绑定：agents 服务不可用，跳过存在性探测（${sessionId}）`)
            } else {
              const live = agents.get(sessionId)
              if (live === undefined || live === null) {
                probeWarning = '这个会话现在不活跃，写日记时会尝试冷启动它'
                note('api', `日记会话绑定：${sessionId} 当前不活跃（agents.get 为空），照常绑定，写日记时会冷启动`)
              }
            }
          } catch (error) {
            note('api', `日记会话绑定：探测 ${sessionId} 失败，跳过（${error instanceof Error ? error.message : error}）`)
          }
          const bornAt = Date.now()
          const next = saveConfig({ diarySessionId: sessionId, diarySessionBornAt: bornAt })
          note('api', `日记会话已绑定：${sessionId}（来源 ${source}，起算 ${bornAt}）`)
          return json(res, 200, {
            ok: true,
            sessionId,
            source,
            bornAt,
            ...(probeWarning === '' ? {} : { warning: probeWarning }),
            config: next
          })
        }

        if (route === '/diary/unbind' && req.method === 'POST') {
          // bornAt 一起清掉：否则概览还会按旧时间显示「日记本 N 天」
          const next = saveConfig({ diarySessionId: '', diarySessionBornAt: 0 })
          note('api', '日记会话绑定已清除')
          return json(res, 200, { ok: true, sessionId: '', config: next })
        }

        // ---- 手动触发日记 ----
        if (route === '/diary' && req.method === 'POST') {
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

        // ---- 笔记（2026-11-04）：她自己写的 md ----
        //
        // 跟私密日记的处理不一样：日记是「写给自己看的」，所以正文不出服务器；
        // 笔记是「她自己整理的东西」，没有那一层私密约定，设置页该能看、能改、能删。
        // 她写了什么你都能在这里看到 —— 这也是这个功能有意思的地方。
        if (route === '/notes/list' && req.method === 'GET') {
          return json(res, 200, { ok: true, notes: listNotes() })
        }

        if (route === '/notes/read' && req.method === 'GET') {
          const got = readNote(String(query.get('title') ?? '').trim())
          if (got.ok !== true) return json(res, 404, { ok: false, error: got.reason })
          return json(res, 200, { ok: true, note: got.note, text: got.text })
        }

        if (route === '/notes/save' && req.method === 'POST') {
          const body = await readBody(req)
          const result = writeNote({
            title: String(body?.title ?? '').trim(),
            content: body?.content,
            // 2026-11-04 修 B8：默认**不覆盖**，跟 soul_note 工具口径一致。
            // 原来写的是 `body.overwrite !== false`（缺省 true），设置页点保存就把同名笔记整篇替换掉，
            // 而工具那边同一个动作是必须显式 overwrite 的 —— 同一个概念两个默认值，早晚出事。
            overwrite: body?.overwrite === true
          })
          if (result.ok !== true) return json(res, 400, { ok: false, error: result.reason })
          return json(res, 200, { ok: true, slug: result.slug, created: result.created })
        }

        if (route === '/notes/rename' && req.method === 'POST') {
          const body = await readBody(req)
          const result = renameNote(String(body?.title ?? '').trim(), String(body?.newTitle ?? '').trim())
          if (result.ok !== true) return json(res, 400, { ok: false, error: result.reason })
          return json(res, 200, { ok: true, slug: result.slug })
        }

        if (route === '/notes/delete' && req.method === 'POST') {
          const body = await readBody(req)
          const result = deleteNote(String(body?.title ?? '').trim())
          if (result.ok !== true) return json(res, 400, { ok: false, error: result.reason })
          return json(res, 200, { ok: true, slug: result.slug })
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
