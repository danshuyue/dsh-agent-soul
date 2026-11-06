/**
 * tool.js —— 给 agent 的两个工具（记忆 + 惦记的事）。
 *
 * ── 工具设计遵循的几条硬规则（来自 DSH 问题库 Q39 / Q07） ──
 *   ① `parameters` 必须是**编译好的 JSON Schema**，`required` 是数组 ——
 *      不能用 defineTool 那套 DSL，否则工具在列表里但模型永远传不对参数。
 *   ② 必须声明 `output: { schema, render }`，否则 register 直接抛 must declare output。
 *   ③ 不 import `@deepseek-ai/dsh-tools`：本地 link 安装时解析不到那个包，整块会崩。
 *   ④ 注册失败必须在 catch 里打日志 —— 被吞掉的注册失败只会表现成「她没有这个工具」。
 *   ⑤ 挂 disposer，否则热重载会 duplicate tool。
 *
 * ── 为什么只有两个工具，而且要合并 action ──
 *   工具 schema 是**每轮重发**的常驻成本（不进压缩）。一个工具一个动作，
 *   五个工具五套 schema，光定义就上千字符。合并成「两个工具 + action 枚举」，
 *   既能覆盖全部能力，又只付两份定义的钱。
 */
import { note, serviceOf } from './env.js'
import {
  closeGoal,
  addGoal,
  openGoals,
  GOAL_KINDS,
  NEED_LABEL
} from './purpose.js'
import {
  globalCard,
  projectCard,
  saveGlobalCard,
  saveProjectCard,
  purposeState,
  savePurposeState,
  writeMemory
} from './store.js'
import { forgetRecord, makeArchiver, recall, setPinned, touchRecords } from './memory.js'
import { appendNote, deleteNote, listNotes, readNote, renameNote, writeNote } from './notes.js'
import { archivePath } from './paths.js'
// 2026-11-04：写入成功后的「回声」—— 让同一会话下一轮能看见刚记下的这条。
import { pushEcho } from './core/echo.js'

/** 工具执行时的 cwd：优先取宿主传的上下文，退化到「最近一次注入的 cwd」。 */
let fallbackCwd = ''
export function setFallbackCwd(cwd) {
  if (typeof cwd === 'string' && cwd.trim() !== '') fallbackCwd = cwd
}

/** 设置页等场景拿兜底 cwd（注入时记下的「最近一次会话的工作目录」）。 */
export function getFallbackCwd() {
  return fallbackCwd
}

function cwdOf(context) {
  const fromContext = context?.agent?.session?.header?.cwd
    ?? context?.session?.header?.cwd
    ?? context?.cwd
  return typeof fromContext === 'string' && fromContext.trim() !== '' ? fromContext : fallbackCwd
}

/**
 * 工具执行时的 session id（2026-11-04）。
 *
 * 只跟 cwdOf 同源：从宿主传进来的 context 上取会话头，**没有全局兜底**。
 * 有些宿主（或测试里的直接调用）拿不到会话 → 返回空串 → 调用方据此不入回声。
 * 为什么宁可丢回执也不能兜底：回声里是刚写下的私事，猜一个 key 就等于把它
 * 塞进别人的提示词。
 */
function sessionIdOf(context) {
  const fromContext = context?.agent?.session?.header?.id
    ?? context?.session?.header?.id
  return typeof fromContext === 'string' && fromContext.trim() !== '' ? fromContext.trim() : ''
}

const SCOPE_ENUM = ['auto', 'global', 'project']

/**
 * 注册记忆工具 `soul_memory`。
 * @returns {Function|undefined} disposer
 */
export function registerMemoryTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      note('tool', '宿主没有 tools 服务，记忆工具未注册')
      return undefined
    }

    const dispose = tools.register({
      name: 'soul_memory',
      description:
        '你自己的长期记忆：记下值得记住的事、回想以前记过的事、忘掉不该留的。'
        + '主人说了偏好/目标/约定，或某件事值得以后还记得时用 write；'
        + '要回忆「之前说过什么」时用 recall。记忆会随时间变模糊，所以别等，值得留的当场记。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['write', 'recall', 'forget', 'pin', 'list'],
            description: 'write 记一条；recall 按关键词回想；forget 忘掉一条；pin 固定为永不遗忘；list 看最近记了什么'
          },
          text: {
            type: 'string',
            description: 'write 时的正文。写「谁说了什么、什么时候、为什么重要」，一句话说完，不要写成流水账'
          },
          query: { type: 'string', description: 'recall 时的关键词，两三个词就够' },
          id: { type: 'string', description: 'forget / pin 时的记忆 id（recall 或 list 会返回）' },
          scope: {
            type: 'string',
            enum: SCOPE_ENUM,
            description: 'auto（默认）先判归属：这条只在这个工作区成立就记项目卡，否则记全局卡；global / project 是手动指定'
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
          if (value?.ok === false) return [{ type: 'text', text: `没成功：${value?.message ?? '未知原因'}` }]
          const items = Array.isArray(value?.items) ? value.items : []
          if (items.length === 0) return [{ type: 'text', text: value?.message ?? '好了。' }]
          const lines = items.map((item) => `[${item.id}] ${item.text}`)
          return [{ type: 'text', text: `${value?.message ?? ''}\n${lines.join('\n')}`.trim() }]
        }
      },
      execute: async (args, context) => {
        const action = String(args?.action ?? '').trim()
        const cwd = cwdOf(context)
        const scope = SCOPE_ENUM.includes(args?.scope) ? args.scope : 'auto'

        if (action === 'write') {
          const text = String(args?.text ?? '').trim()
          if (text === '') return { ok: false, message: 'text 不能为空' }
          const result = writeMemory({
            cwd,
            scope,
            input: { text, source: 'tool', isOwner: true, isPrivate: true }
          })
          if (result.ok !== true) return { ok: false, message: result.reason ?? '写入失败' }
          // 2026-11-04：写入成功后挂一条回声。只对 write 生效 —— forget / pin
          // 不产生新记忆，回显它们没有意义。sessionId 拿不到就不入回声（不兜底）。
          const sessionId = sessionIdOf(context)
          if (sessionId !== '') pushEcho(sessionId, String(result.record?.text ?? text))
          const reasons = Array.isArray(result.reasons) ? `（${result.reasons.join('、')}）` : ''
          return {
            ok: true,
            message: result.deduped === true
              ? `这条已经在记着了，刷新了一下：${result.record.text.slice(0, 40)}`
              : `记住了${reasons}：${result.record.text.slice(0, 40)}`
          }
        }

        if (action === 'recall') {
          const query = String(args?.query ?? '').trim()
          if (query === '') return { ok: false, message: 'query 不能为空' }
          const cards = [{ card: globalCard(), label: '全局', save: () => saveGlobalCard(globalCard()) }]
          if (cwd !== '') {
            cards.push({ card: projectCard(cwd), label: '本项目', save: () => saveProjectCard(cwd, projectCard(cwd)) })
          }
          const items = []
          const saveErrors = []
          for (const entry of cards) {
            const hitIds = []
            for (const hit of recall(entry.card, query, { limit: 6 })) {
              hitIds.push(hit.record.id)
              items.push({
                id: hit.record.id,
                text: `${hit.record.text.slice(0, 120)}（${hit.record.clarity}·${entry.label}）`,
                record: hit.record
              })
            }
            // 被想起来的记忆要「刷新」：lastSeenAt 更新、recallCount +1、清晰度回升一档。
            // 不调用的话 README 写的「被再次提及就刷新时间、召回 +1」就是一句空话，
            // 而且越常想起的事反而会正常衰减到消失。
            if (hitIds.length > 0 && touchRecords(entry.card, hitIds) > 0) {
              // 2026-11-05 修 P0-4：刷新没落盘也要报，不能让 recall 假装成功。
              const saved = entry.save()
              if (saved?.ok !== true) saveErrors.push(`${entry.label}：${saved?.error ?? '未知原因'}`)
            }
          }
          if (saveErrors.length > 0) {
            return { ok: false, message: `想起了 ${items.length} 条，但刷新记忆落盘失败：${saveErrors.join('；')}（改动仍在内存缓存，可重试）` }
          }
          items.sort((a, b) => (b.record.importance ?? 0) - (a.record.importance ?? 0))
          return {
            ok: true,
            message: items.length === 0 ? `关于「${query}」没想起什么。` : `关于「${query}」想起 ${items.length} 条：`,
            items: items.slice(0, 8)
          }
        }

        if (action === 'forget') {
          const id = String(args?.id ?? '').trim()
          if (id === '') return { ok: false, message: 'id 不能为空（先 recall 或 list 拿到 id）' }
          const cards = [{ card: globalCard(), save: () => saveGlobalCard(globalCard()), label: '全局' }]
          if (cwd !== '') cards.push({ card: projectCard(cwd), save: () => saveProjectCard(cwd, projectCard(cwd)), label: '本项目' })
          // 走 forgetRecord 而不是自己 splice：它会把删掉的这条写进 archive.jsonl，
          // 以后「她为什么把这件事忘了」还能查回来（README 承诺的）
          const archive = makeArchiver(archivePath())
          for (const entry of cards) {
            const removed = forgetRecord(entry.card, id, archive)
            if (removed?.ok !== true) {
              // R01：归档失败时记录仍留在卡里，绝不能继续往下报「忘掉了」。
              if (removed?.error === 'archive-failed') {
                return { ok: false, message: '归档失败，这条记忆仍留在卡里（没有删除）：archive.jsonl 写不进去，请检查磁盘与权限后重试' }
              }
              continue
            }
            // 2026-11-05 修 P0-4：这条最阴 —— archive.jsonl 已写、内存已删，
            // 唯独删除没落盘。以前照样回「忘掉了」，用户以为隐私删了，
            // 重启后记忆从磁盘复活。现在必须把失败说清楚。
            const saved = entry.save()
            if (saved?.ok !== true) {
              return {
                ok: false,
                message: `已从内存移除，但删除没落盘：${saved?.error ?? '未知原因'}（重启后可能复活，请重试）`
              }
            }
            note('tool', `忘掉一条（${entry.label}）：${removed.record.text.slice(0, 40)}`)
            return { ok: true, message: `忘掉了：${removed.record.text.slice(0, 40)}` }
          }
          return { ok: false, message: `没找到 id=${id} 的记忆` }
        }

        if (action === 'pin') {
          const id = String(args?.id ?? '').trim()
          if (id === '') return { ok: false, message: 'id 不能为空' }
          const cards = [{ card: globalCard(), save: () => saveGlobalCard(globalCard()) }]
          if (cwd !== '') cards.push({ card: projectCard(cwd), save: () => saveProjectCard(cwd, projectCard(cwd)) })
          for (const entry of cards) {
            if (setPinned(entry.card, id, true)) {
              // 2026-11-05 修 P0-4：同 forget，固定状态没落盘不能报成功。
              const saved = entry.save()
              if (saved?.ok !== true) {
                return { ok: false, message: `固定没落盘：${saved?.error ?? '未知原因'}（改动仍在内存缓存，可重试）` }
              }
              return { ok: true, message: '固定好了，这条以后不会变模糊。' }
            }
          }
          return { ok: false, message: `没找到 id=${id} 的记忆` }
        }

        if (action === 'list') {
          // 项目卡也要列：不然模型往 project 作用域写进去的东西，自己拿不到 id，
          // forget / pin 对项目记忆基本用不了
          const cards = [{ card: globalCard(), label: '全局' }]
          if (cwd !== '') cards.push({ card: projectCard(cwd), label: '本项目' })
          const items = []
          for (const entry of cards) {
            for (const record of entry.card.records.slice(-10).reverse()) {
              items.push({ id: record.id, text: `${record.text.slice(0, 80)}（${record.clarity}·${entry.label}）` })
            }
          }
          return {
            ok: true,
            message: items.length === 0 ? '还没记下什么。' : '最近记下的：',
            items: items.slice(0, 20)
          }
        }

        return { ok: false, message: `不认识的 action：${action}` }
      }
    })

    if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, 'dsh-agent-soul: soul_memory tool')
    }
    note('tool', 'soul_memory 已注册')
    return dispose
  } catch (error) {
    note('tool', `soul_memory 注册失败：${error instanceof Error ? error.message : error}`)
    return undefined
  }
}

/**
 * 注册目标工具 `soul_goal` —— 「心里惦记的事」。
 *
 * 这是目的机制的入口：她自己往上加，做完了自己关掉。
 * 不加这个工具的话，目标只能靠自动从记忆里挖，她没法表达「我现在想弄这个」。
 */
export function registerGoalTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      note('tool', '宿主没有 tools 服务，目标工具未注册')
      return undefined
    }

    const kinds = Object.entries(GOAL_KINDS).map(([key, label]) => `${key}=${label}`).join('，')
    const dispose = tools.register({
      name: 'soul_goal',
      description:
        '你自己心里惦记的事（不是主人派的任务）。想到「这个我想弄明白」「这个答应过要做」时 add；'
        + '做完了或决定不做了用 done 关掉。这些会在之后的对话里提醒你，所以别把普通待办都塞进来。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['add', 'done', 'list'], description: 'add 记一件惦记的事；done 关掉；list 看还惦记着什么' },
          text: { type: 'string', description: 'add 时的内容。一句话，写清「想做什么」而不是「刚才聊了什么」' },
          kind: { type: 'string', enum: Object.keys(GOAL_KINDS), description: `可选；${kinds}。默认 curious` },
          id: { type: 'string', description: 'done 时的目标 id（list 会返回）' }
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
          if (value?.ok === false) return [{ type: 'text', text: `没成功：${value?.message ?? '未知原因'}` }]
          const items = Array.isArray(value?.items) ? value.items : []
          if (items.length === 0) return [{ type: 'text', text: value?.message ?? '好了。' }]
          return [{ type: 'text', text: `${value?.message ?? ''}\n${items.map((item) => `[${item.id}] ${item.text}`).join('\n')}`.trim() }]
        }
      },
      execute: async (args) => {
        const action = String(args?.action ?? '').trim()
        const state = purposeState()

        if (action === 'add') {
          const result = addGoal(state, {
            text: String(args?.text ?? ''),
            kind: args?.kind,
            source: 'tool',
            weight: 60
          })
          if (result.ok !== true) return { ok: false, message: result.reason ?? '没加上' }
          // 2026-11-05：写盘失败不能回「记下了」。改动仍在内存缓存，可重试。
          const saved = savePurposeState(state)
          if (saved.ok !== true) return { ok: false, message: `目标写盘失败：${saved.error}（改动仍在内存）` }
          return { ok: true, message: `记下了，你会惦记着：${result.goal.text}` }
        }

        if (action === 'done') {
          const id = String(args?.id ?? '').trim()
          if (id === '') return { ok: false, message: 'id 不能为空（先 list 拿 id）' }
          if (!closeGoal(state, id)) return { ok: false, message: `没找到 id=${id} 的目标` }
          const saved = savePurposeState(state)
          if (saved.ok !== true) return { ok: false, message: `目标写盘失败：${saved.error}（改动仍在内存）` }
          return { ok: true, message: '这件事放下了。' }
        }

        if (action === 'list') {
          const open = openGoals(state, { limit: 20 })
          return {
            ok: true,
            message: open.length === 0 ? '现在心里没有特别惦记的事。' : `还惦记着 ${open.length} 件：`,
            items: open.map((goal) => ({
              id: goal.id,
              text: `${goal.text}（${GOAL_KINDS[goal.kind] ?? '想试试'}·权重 ${goal.weight}）`
            }))
          }
        }

        return { ok: false, message: `不认识的 action：${action}` }
      }
    })

    if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, 'dsh-agent-soul: soul_goal tool')
    }
    note('tool', 'soul_goal 已注册')
    return dispose
  } catch (error) {
    note('tool', `soul_goal 注册失败：${error instanceof Error ? error.message : error}`)
    return undefined
  }
}

/** 需求维度的中文名，给设置页与日志用。 */
export const NEED_LABELS = NEED_LABEL

/**
 * 注册笔记工具 `soul_note` —— 她自己写的 md（2026-11-04）。
 *
 * ── 为什么不塞进 soul_memory 的 action ──
 * tool.js 顶部那条「schema 是每轮重发的常驻成本」说的是**别开五个小工具**，
 * 不是「什么都塞进一个」。记忆的 action 已经五个了（write/recall/forget/pin/list），
 * 再往里加 note_* 会让模型在「记一条」和「写一篇」之间反复拿不准 —— 实测这类
 * 语义混淆比多付几百字符的 schema 贵得多。所以单独一份精简 schema，划清边界。
 *
 * ── 边界怎么划（描述里必须写清，否则她一定混）──
 *   记忆：一句一条的事实/偏好/约定，会衰减、会被压缩掉。
 *   笔记：成篇的东西。观察、想法、想问她的话、整理过的理解。
 *   判据一句话：**「一句话说得完的进记忆，要分段的写笔记」**。
 */
export function registerNoteTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      note('tool', '宿主没有 tools 服务，笔记工具未注册')
      return undefined
    }

    const dispose = tools.register({
      name: 'soul_note',
      description:
        '你自己的笔记本：可以自己建文档、写想记住的东西、回头翻看和修改。'
        + '这是你自己写的，没人要求你写，也不会随时间淡忘。'
        + '跟 soul_memory 的区别：一句话说得完的零碎事实用 soul_memory；'
        + '要分段落、要成一个主题（观察、想法、想问的事、整理过的理解）就写笔记。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'write', 'append', 'rename', 'delete'],
            description: 'list 看有哪些篇；read 读全文；write 新建或整篇覆盖；append 在后面续写；rename 改标题；delete 删掉'
          },
          title: { type: 'string', description: '笔记标题，也是文件名。中文即可，别加斜杠和 ..' },
          content: { type: 'string', description: 'write / append 的正文，md 格式，可以分段' },
          newTitle: { type: 'string', description: 'rename 时的新标题' },
          overwrite: { type: 'boolean', description: 'write 时若同名已存在，是否整篇替换。默认 false（会报错提醒你改用 append）' }
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
            items: { type: 'array', items: { type: 'object' } },
            text: { type: 'string' }
          }
        },
        render: (args, value) => {
          if (value?.ok === false) return [{ type: 'text', text: `没成功：${value?.message ?? '未知原因'}` }]
          const items = Array.isArray(value?.items) ? value.items : []
          if (typeof value?.text === 'string' && value.text !== '') {
            return [{ type: 'text', text: `${value?.message ?? ''}\n\n${value.text}`.trim() }]
          }
          if (items.length === 0) return [{ type: 'text', text: value?.message ?? '好了。' }]
          return [{ type: 'text', text: `${value?.message ?? ''}\n${items.map((item) => `- ${item.text}`).join('\n')}`.trim() }]
        }
      },
      execute: async (args) => {
        const action = String(args?.action ?? '').trim()
        const title = String(args?.title ?? '').trim()

        if (action === 'list') {
          const notes = listNotes()
          if (notes.length === 0) {
            return {
              ok: true,
              message: '你的笔记本还是空的。想写点什么的话，action=write 加一个标题就能建。'
            }
          }
          return {
            ok: true,
            message: `你的笔记本里有 ${notes.length} 篇：`,
            items: notes.map((entry) => ({
              text: `${entry.title}（${entry.chars} 字，${agoText(entry.updatedAt)}改过）${entry.summary === '' ? '' : `　${entry.summary}`}`
            }))
          }
        }

        if (action === 'read') {
          const got = readNote(title)
          if (got.ok !== true) return { ok: false, message: got.reason }
          return { ok: true, message: `「${got.note.title}」（${got.text.length} 字）：`, text: got.text }
        }

        if (action === 'write') {
          const result = writeNote({
            title,
            content: args?.content,
            overwrite: args?.overwrite === true
          })
          if (result.ok !== true) return { ok: false, message: result.reason }
          return {
            ok: true,
            message: result.created
              ? `新建了《${result.slug}》（${result.entry.chars} 字）。`
              : `重写了《${result.slug}》（${result.entry.chars} 字）。`
          }
        }

        if (action === 'append') {
          const result = appendNote({ title, content: args?.content })
          if (result.ok !== true) return { ok: false, message: result.reason }
          return { ok: true, message: `《${result.slug}》续写好了（现在 ${result.entry.chars} 字）。` }
        }

        if (action === 'rename') {
          const result = renameNote(title, String(args?.newTitle ?? '').trim())
          if (result.ok !== true) return { ok: false, message: result.reason }
          return {
            ok: true,
            message: result.renamed ? `改名好了：《${title}》→《${result.slug}》。` : '标题没变。'
          }
        }

        if (action === 'delete') {
          const result = deleteNote(title)
          if (result.ok !== true) return { ok: false, message: result.reason }
          return { ok: true, message: `《${result.slug}》删掉了（放在回收站里，找得回来）。` }
        }

        return { ok: false, message: `不认识的 action：${action}` }
      }
    })

    if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, 'dsh-agent-soul: soul_note tool')
    }
    note('tool', 'soul_note 已注册')
    return dispose
  } catch (error) {
    note('tool', `soul_note 注册失败：${error instanceof Error ? error.message : error}`)
    return undefined
  }
}

/** 「3 天前改过」这种人话，比时间戳好读。 */
function agoText(at) {
  const diff = Date.now() - (Number(at) || 0)
  if (diff < 0 || diff < 60_000) return '刚刚'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days} 天前` : `${Math.floor(days / 30)} 个月前`
}
