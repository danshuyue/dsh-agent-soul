/**
 * diary-tool.js —— 给她一个「自己写日记」的工具（2026-11-04）。
 *
 * ── 为什么需要这个工具 ──
 *   日记原来是插件代笔：`llm.stream` 生成 → `writeDiaryFile` 直接写盘，她全程没参与，
 *   只是被当成一个无状态模型调用了一次。改成「她自己写」之后，她需要一个能落盘的入口 ——
 *   而 `soul_note` 只能写 `agents/notes/`，碰不到 `agents/diary/`。
 *   没有这个工具，投过去的消息她收到了也写不出来，最后还是会掉回兜底生成。
 *
 * ── 为什么单独一个工具，不加进 soul_note 的 kind ──
 *   日记和笔记的约束完全不同：日记有**日期**（一天一篇、不能写未来、只能补最近几天）、
 *   有**公开/私密**两个面、首行格式还由插件统一补。这些塞进 soul_note 会让它的
 *   schema 立刻膨胀，而笔记那边的「标题即文件名」语义也会被污染。
 *
 * ── 为什么不用通用文件写入 ──
 *   宿主的工具集打包在 exe 里，查不到她到底有没有 write_file；就算有，让她自己拼
 *   `agents/diary/public/2026-11-03.md` 这种路径，拼错一次就是写了一篇谁也找不到的日记。
 *   这里把路径、日期、格式全收在插件内部，她只说「写哪篇、写什么」。
 */
import { note, serviceOf } from './env.js'
import { diaryPrivatePath, diaryPublicPath, exists, readText } from './paths.js'
import { todayKey, writeDiaryFile, yesterdayKey } from './diary.js'

const DAY_MS = 86_400_000
/** 能往回补多少天。流水现在不再定期清理，所以往回补多少天只受这个上限约束。 */
const MAX_BACK_DAYS = 14
/** 单篇日记的字数上限（2026-11-07 P2-32）：与 notes 的 20000 同量级。 */
const MAX_DIARY_CHARS = 20_000
const KINDS = ['public', 'private']

const pad2 = (n) => String(n).padStart(2, '0')

/** 时间戳 → YYYY-MM-DD（本地时区，跟 diary.js 的日期口径一致）。 */
function dateKeyOf(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * 校验日期。空串 = 昨天（跟触发时机一致）。
 *
 * 为什么要拦未来和太久以前：她能写「2027-01-01」的话，看门狗以后每天都会认为
 * 「昨天没写」，于是一遍遍重写；写「2020-01-01」则是在往归档里塞不存在的日子。
 * @returns {{ ok: true, date: string } | { ok: false, reason: string }}
 */
export function checkDiaryDate(raw, now = Date.now()) {
  const text = String(raw ?? '').trim()
  const key = text === '' ? yesterdayKey(now) : text
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return { ok: false, reason: `日期要写成 YYYY-MM-DD（收到的是「${key}」）` }
  }
  const d = new Date(`${key}T00:00:00`)
  if (Number.isNaN(d.getTime())) return { ok: false, reason: `「${key}」不是一个真实日期` }
  // Date 会把 2026-02-30 悄悄滚成 03-02，回读一遍才能挡住这种「看起来合法」的日期
  const back = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  if (back !== key) return { ok: false, reason: `「${key}」不存在这一天` }

  const todayStart = new Date(`${todayKey(now)}T00:00:00`).getTime()
  const t = d.getTime()
  if (t > todayStart) return { ok: false, reason: '不能写还没过完的日子' }
  if (todayStart - t > MAX_BACK_DAYS * DAY_MS) {
    return { ok: false, reason: `只能写最近 ${MAX_BACK_DAYS} 天里的日记` }
  }
  return { ok: true, date: key }
}

/**
 * 注册 `soul_diary` 工具。
 * @returns {Function|undefined} disposer
 */
export function registerDiaryTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      note('tool', '宿主没有 tools 服务，日记工具未注册')
      return undefined
    }

    const dispose = tools.register({
      name: 'soul_diary',
      description:
        '写今天的日记（公开那篇会给人看，私密那篇只有你自己看）。'
        + '平时不用你操心 —— 插件会在该写的时候把话题投给你；收到之后用这个工具把正文写进去。'
        + '格式不用你补，首行和日期插件会加，直接写正文就行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['write', 'look'],
            description: 'write 写一篇；look 看最近几天写了没有'
          },
          kind: {
            type: 'string',
            enum: KINDS,
            description: 'write 时必填：public 公开（会给人看）/ private 私密（只有你自己看）'
          },
          date: { type: 'string', description: '哪一天，YYYY-MM-DD。不填就是昨天' },
          content: { type: 'string', description: 'write 时的正文，md 格式。首行和日期不用写，插件会补' },
          overwrite: {
            type: 'boolean',
            description: '那一天已经有这篇日记时，是否整篇替换。默认 false（会报错提醒你确认）'
          }
        },
        required: ['action']
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            items: { type: 'array', items: { type: 'object' } }
          }
        },
        render: (args, value) => {
          if (value?.ok === false) return [{ type: 'text', text: `没写成：${value?.message ?? '未知原因'}` }]
          const items = Array.isArray(value?.items) ? value.items : []
          if (items.length === 0) return [{ type: 'text', text: value?.message ?? '好了。' }]
          return [{ type: 'text', text: `${value?.message ?? ''}\n${items.map((item) => `- ${item.text}`).join('\n')}`.trim() }]
        }
      },
      execute: async (args) => {
        const action = String(args?.action ?? '').trim()

        if (action === 'look') {
          const items = []
          for (let i = 0; i <= 6; i += 1) {
            const key = dateKeyOf(Date.now() - i * DAY_MS)
            const hasPublic = exists(diaryPublicPath(key))
            const hasPrivate = exists(diaryPrivatePath(key))
            if (!hasPublic && !hasPrivate) {
              items.push({ text: `${key}：还没写` })
              continue
            }
            const preview = hasPublic ? readText(diaryPublicPath(key)).replace(/\s+/g, ' ').slice(0, 30) : ''
            items.push({
              text: `${key}：${hasPublic ? '公开✓' : '公开✗'} ${hasPrivate ? '私密✓' : '私密✗'}${preview === '' ? '' : `　${preview}`}`
            })
          }
          return { ok: true, message: '最近 7 天：', items }
        }

        if (action === 'write') {
          const kind = String(args?.kind ?? '').trim()
          if (!KINDS.includes(kind)) return { ok: false, message: 'kind 只能填 public 或 private' }
          const checked = checkDiaryDate(args?.date)
          if (checked.ok !== true) return { ok: false, message: checked.reason }
          const body = String(args?.content ?? '').trim()
          if (body === '') return { ok: false, message: '正文不能空' }
          // 2026-11-07 R11 / P2-32：正文没有上限 —— 她一次写几万字进来，
          // 这篇会进「最近日记」的历史段，**每回合都撑一次注入预算**（notes 早就有 20000 上限，
          // 日记没有）。这里按同一个量级卡住，并且明确告诉她为什么，而不是静默截断。
          if (body.length > MAX_DIARY_CHARS) {
            return {
              ok: false,
              message: `日记太长（${body.length} 字，上限 ${MAX_DIARY_CHARS}）—— 超出的部分会一直挤占每轮注入的预算。请精简后再写。`
            }
          }

          const label = kind === 'private' ? '私密' : '公开'
          // 2026-11-04 修 B2：已存在时必须显式 overwrite。
          //
          // 原来这里直接 writeDiaryFile，而 date 不填默认「昨天」——
          // 她漏传一次 date，就会把看门狗已经写好的昨天那篇**整篇静默替换**掉。
          // 这是全插件唯一一条「一次调用覆盖整篇成品」的路径，
          // 而 writeNote 那边同名是必须显式 overwrite 的，口径必须统一。
          const target = kind === 'private' ? diaryPrivatePath(checked.date) : diaryPublicPath(checked.date)
          const existed = exists(target)
          if (existed && args?.overwrite !== true) {
            return {
              ok: false,
              message: `${checked.date} 的${label}日记已经写好了。真要整篇重写请带 overwrite=true；`
                + '想补写几句请用 read 读出来再重写完整正文。'
            }
          }
          if (!writeDiaryFile(kind, checked.date, body)) {
            return { ok: false, message: '写盘失败，日志里有原因' }
          }
          return {
            ok: true,
            message: existed
              ? `${checked.date} 的${label}日记已整篇重写（${body.length} 字）。`
              : `${checked.date} 的${label}日记写好了（${body.length} 字）。`
          }
        }

        return { ok: false, message: `不认识的 action：${action}` }
      }
    })

    if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, 'dsh-agent-soul: soul_diary tool')
    }
    note('tool', 'soul_diary 已注册')
    return dispose
  } catch (error) {
    note('tool', `soul_diary 注册失败：${error instanceof Error ? error.message : error}`)
    return undefined
  }
}
