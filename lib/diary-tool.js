/**
 * diary-tool.js —— 给她一个「自己写摘录」的工具（2026-11-04；2026-11-21 改成摘录）。
 *
 * ── 为什么需要这个工具 ──
 *   摘录原来也是插件代笔，她全程没参与。改成「她自己写」之后，她需要一个能落盘的入口 ——
 *   而 `soul_note` 只能写 `agents/notes/`，碰不到 `agents/diary/`。
 *   没有这个工具，投过去的消息她收到了也写不出来，最后还是会掉回规则化兜底。
 *
 * ── 为什么单独一个工具，不加进 soul_note 的 kind ──
 *   摘录有**日期**（一天一篇、不能写未来、只能补最近几天），首行日期还由插件统一补。
 *   这些塞进 soul_note 会让它的 schema 立刻膨胀，而笔记那边的「标题即文件名」语义也会被污染。
 *
 * ── 0.10.0 的接口变化 ──
 *   kind 从 `public | private` 收成 `excerpt`；action=look 仍然能翻最近 7 天写没写。
 *   正文会走 excerpt.js 的清洗（去时间戳/标题、只留一行一条、按上限裁），
 *   所以她把整篇 markdown 塞进来也不会写出格式错的文件。
 */
import { note, serviceOf } from './env.js'
import { diaryExcerptPath, exists, readText } from './paths.js'
import { todayKey, writeExcerptFile, yesterdayKey } from './diary.js'
import { excerptLinesFromFile } from './diary/excerpt.js'

const DAY_MS = 86_400_000
/** 能往回补多少天。流水现在不再定期清理，所以往回补多少天只受这个上限约束。 */
const MAX_BACK_DAYS = 14
/** 一天摘录的原始正文字数上限：与 notes 的 20000 同量级，挡住「一次塞几万字进来」。 */
const MAX_EXCERPT_CHARS = 20_000
const KINDS = ['excerpt']

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
    return { ok: false, reason: `只能写最近 ${MAX_BACK_DAYS} 天里的摘录` }
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
      note('tool', '宿主没有 tools 服务，摘录工具未注册')
      return undefined
    }

    const dispose = tools.register({
      name: 'soul_diary',
      description:
        '写这一天的摘录（一行一条的事实：对什么、做了什么）。'
        + '平时不用你操心 —— 插件会在该写的时候把话题投给你；收到之后用这个工具把正文写进去。'
        + '首行的日期插件会补，直接写条目就行（每条以「- 」开头，不写时间、不写感受）。',
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
            description: 'write 时填 excerpt（摘录）'
          },
          date: { type: 'string', description: '哪一天，YYYY-MM-DD。不填就是昨天' },
          content: { type: 'string', description: 'write 时的正文，一行一条。首行日期不用写，插件会补' },
          overwrite: {
            type: 'boolean',
            description: '那一天已经有摘录时，是否整篇替换。默认 false（会报错提醒你确认）'
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
            const file = diaryExcerptPath(key)
            if (!exists(file)) {
              items.push({ text: `${key}：还没写` })
              continue
            }
            const lines = excerptLinesFromFile(readText(file))
            const head = lines.length === 0 ? '（今天没有对话）' : lines.slice(0, 2).join(' / ')
            items.push({ text: `${key}：${lines.length} 条　${head}` })
          }
          return { ok: true, message: '最近 7 天：', items }
        }

        if (action === 'write') {
          const kind = String(args?.kind ?? 'excerpt').trim()
          if (!KINDS.includes(kind)) return { ok: false, message: `kind 只能填 ${KINDS.join(' 或 ')}` }
          const checked = checkDiaryDate(args?.date)
          if (checked.ok !== true) return { ok: false, message: checked.reason }
          const body = String(args?.content ?? '').trim()
          if (body === '') return { ok: false, message: '正文不能空' }
          // 2026-11-07 R11 / P2-32：正文没有上限 —— 她一次塞几万字进来，
          // 清洗和写盘都会变成负担，而且摘录本来就不该长。这里明确告诉她为什么。
          if (body.length > MAX_EXCERPT_CHARS) {
            return {
              ok: false,
              message: `摘录太长（${body.length} 字，上限 ${MAX_EXCERPT_CHARS}）—— 摘录是一行一条的事实，请精简后再写。`
            }
          }

          // 2026-11-04 修 B2：已存在时必须显式 overwrite。
          //
          // 原来这里直接写盘，而 date 不填默认「昨天」——
          // 她漏传一次 date，就会把看门狗已经写好的昨天那篇**整篇静默替换**掉。
          // 这是全插件唯一一条「一次调用覆盖整篇成品」的路径，
          // 而 writeNote 那边同名是必须显式 overwrite 的，口径必须统一。
          const existed = exists(diaryExcerptPath(checked.date))
          if (existed && args?.overwrite !== true) {
            return {
              ok: false,
              message: `${checked.date} 的摘录已经写好了。真要整篇重写请带 overwrite=true；`
                + '想补写几条请用 action=look 读出来再重写完整正文。'
            }
          }
          if (!writeExcerptFile(checked.date, body)) {
            return { ok: false, message: '写盘失败，日志里有原因' }
          }
          return {
            ok: true,
            message: existed
              ? `${checked.date} 的摘录已整篇重写（${body.length} 字）。`
              : `${checked.date} 的摘录写好了（${body.length} 字）。`
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
