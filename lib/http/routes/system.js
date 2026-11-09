/**
 * HTTP 路由 · system.js（2026-11-06 P16）。
 * 由 lib/http/server.js 的 registerApi 分支体经 P15 提取后整体搬来，函数体逐字未改。
 * 分派逻辑仍在 server.js；本文件只负责「某个路由具体做什么」。
 */

import { DEFAULT_CONFIG, loadConfig, maintain, memoryHealth, memoryStats, moodState, purposeState, saveConfig } from '../../store.js'
import { composePersona, localPersonaPath, resolveSources, storedProjectPersonaPath } from '../../persona.js'
import { MEMORY_FACTS } from '../../core/facts.js'
import { diaryPrivatePath, diaryPublicPath, exists, globalPersonaPath, slugFor } from '../../paths.js'
import { attestationState } from '../../attest.js'
import { openGoals, summarize } from '../../purpose.js'
import { diarySessionDays, resolveCwd, resolvePostCwd } from '../sessions.js'
import { deleteSecret, saveSecret, secretInfo } from '../../core/secrets.js'
import { dirname, join } from 'node:path'
import { displayDimPercents, displayDims, moodFace, moodLabel, topDims } from '../../mood.js'
import { hostProbeState } from '../../core/host.js'
import { json, readBody, validateConfigEntry, LEGACY_CONFIG_KEYS } from '../middleware.js'
import { listWorkspaces, registerProject } from '../../core/registry.js'
import { note } from '../../env.js'
import { todayKey, yesterdayKey } from '../../diary.js'
import { spawn } from 'node:child_process'
import { statuses as switchStatuses } from '../../evidence.js'
import { globalCard } from '../../store.js'
import { loadIndex } from '../../notes.js'


export async function handleGetAttestation(ctx, req, res, query, route) {
          return json(res, 200, { ok: true, ...attestationState() })
}

/** 配置文件里实际还躺着的废弃键（给用户看的：它们现在没有效果）。 */
function legacyKeysInFile() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf8'))
    return [...LEGACY_CONFIG_KEYS].filter((key) => raw[key] !== undefined)
  } catch {
    return []
  }
}

let legacyLogged = new Set()

export async function handleGetState(ctx, req, res, query, route) {
          // cwd 三级兜底（学 dsh-agent-md）：设置页是全局弹层，某些 DSH 版本
          // 不给 settings.section 传会话 cwd，光靠 query 会整块灰死。
          //   ① 页面显式传的（宿主 props 或用户手选） ② 最近活跃的会话 ③ 最近一次注入记下的
          // 三级兜底抽到 resolveCwd 里了 —— 这套逻辑以前只属于本路由，
          // /mood 那边没有，于是概览和详情读到了两份不同的心情文件
          const cwdPick = resolveCwd(ctx, query)
          const cwd = cwdPick.cwd
          const cwdSource = cwdPick.source
          // R01 / R2-c：归属被拒时 cwd 是空串，下面那套「项目人格」解析
          // 一个字符都不能往外带 —— 否则等于换条路径又把那个目录读了一遍。
          const unowned = cwdSource === 'rejected-unowned'
          // 03 答复 §2.1：**不做任何形式的自动登记**。
          // 以前这里会对判定通过的 cwd 补一次 registerProject，于是「宿主会话给的路径」
          // 在下一次请求就变成「已登记工作区」—— 条件 ① 会顺带接管条件 ③，
          // 而且用户传进来的路径最终还是落进了登记表。登记只保留两个显式入口：
          // POST /register 与宿主的文件选择器（server.js:372）。
          const config = loadConfig()
          // cwd 为空时 composePersona 自然只出全局人格；rejected 时连它也不带出去，
          // 只保留 mode（让设置页知道该画哪一栏），正文 / 来源 / 预览全部置空。
          const persona = unowned
            ? { mode: composePersona({ cwd: '', config }).mode, sources: [], text: '', truncated: false }
            : composePersona({ cwd, config })
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
            legacyKeys: legacyKeysInFile(),
            // 2026-11-10 R18-C：开关的「生效 / 未生效」证据（静态 + 动态计数）
            switches: switchStatuses(config, {
              memoryRecords: (() => { try { return globalCard().records.length } catch { return undefined } })(),
              notesCount: (() => { try { return loadIndex().notes.length } catch { return undefined } })()
            }),
            config,
            persona: unowned
              ? { mode: persona.mode, sources: [], chars: 0, truncated: false, preview: '', available: false }
              : {
                mode: persona.mode,
                sources: persona.sources,
                chars: persona.text.length,
                truncated: persona.truncated,
                preview: persona.text.slice(0, 400),
                available: true
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
            // R2-a 的另一半：归属被拒时不回显本机所有工作区的绝对路径。
            // 正常路径（已登记 / DSH_HOME / 宿主会话）行为完全不变。
            workspaces: unowned ? [] : listWorkspaces(),
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

export async function handlePostConfig(ctx, req, res, query, route) {
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
            // 2026-11-10 R18-B：废弃键「接受但不落盘」—— 它们只是兼容占位，
            // 照原样写回 config.json 会让它们在文件里永远活着，看起来像有效配置。
            // 每个进程每键只记一行日志，不刷屏。
            if (check.legacy === true) {
              if (legacyLogged.has(key) === false) {
                legacyLogged.add(key)
                note('config', `忽略已废弃配置键 ${key}（旧版遗留，当前无效果；不写入配置文件）`)
              }
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

export async function handlePostSecret(ctx, req, res, query, route) {
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

export async function handlePostRegister(ctx, req, res, query, route) {
          const body = await readBody(req)
          // 2026-11-06 第二份审查 M-5：登记表是归属判定的条件①，不能无条件信任 body.cwd。
          // 只接受「已登记 / 宿主会话给的 / DSH_HOME 内」三类；手打路径请走「选择文件夹」。
          const pick = resolvePostCwd(ctx, body)
          if (pick.source !== 'body') {
            const why = pick.source === 'none' ? '缺少 cwd'
              : pick.source === 'rejected' ? '这个路径不是真实存在的目录'
              : '这个目录还没被登记，也不是当前会话的工作区'
            return json(res, 400, {
              ok: false,
              error: `${why}。新增工作区请用「选择文件夹」，或在设置页的下拉框里选一个已有的。`,
              cwdSource: pick.source
            })
          }
          const cwd = pick.cwd
          const registry = registerProject(cwd, { active: body.active === true })
          return json(res, 200, { ok: true, registry, slug: slugFor(cwd).slug })
}

export async function handlePostOpen(ctx, req, res, query, route) {
          const body = await readBody(req)
          const kind = body?.kind === 'project' ? 'project' : 'global'
          // 2026-11-06 M-5：同样走写侧入口，不认没归属的 cwd
          const pick = resolvePostCwd(ctx, body)
          const cwd = pick.source === 'body' ? pick.cwd : ''
          if (kind === 'project' && cwd === '') {
            return json(res, 400, { ok: false, error: '没有可用的工作目录（未登记或不属于当前会话），不知道要打开哪一份' })
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
            // 2026-11-07 P1-S4：同 server.js 的 /pick，错误原文（含绝对路径）不外泄
            const reason = error instanceof Error ? error.message : String(error)
            const code = `SOUL_${Date.now().toString(36)}`
            note('api', `打开人格文件失败（${code}）：${reason}`)
            return json(res, 500, { ok: false, error: '打开失败，详情见 agents/soul.log', code })
          }
}

export async function handlePostMaintain(ctx, req, res, query, route) {
          const body = await readBody(req)
          // 2026-11-06 M-5：写侧入口；没归属就回落到宿主给的 cwd，不认 body 那个
          const pick = resolvePostCwd(ctx, body)
          const cwd = pick.source === 'body' ? pick.cwd : resolveCwd(ctx, query).cwd
          const report = maintain(cwd, loadConfig())
          // 2026-11-05 修 P0-4：维护里任何一次卡写盘失败都要让这次请求失败，
          // 否则前端看到的仍是「维护完成」，实际衰减/压缩根本没落盘。
          if (Array.isArray(report.errors) && report.errors.length > 0) {
            return json(res, 500, { ok: false, error: '维护写盘失败', report })
          }
          return json(res, 200, { ok: true, report })
}
