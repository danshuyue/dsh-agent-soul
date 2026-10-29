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
import { archivePath } from './paths.js'

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

const SCOPE_ENUM = ['global', 'project']

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
            description: 'global 记到所有会话都看得到的地方；project 只记在当前项目里。默认 global'
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
        const scope = SCOPE_ENUM.includes(args?.scope) ? args.scope : 'global'

        if (action === 'write') {
          const text = String(args?.text ?? '').trim()
          if (text === '') return { ok: false, message: 'text 不能为空' }
          const result = writeMemory({
            cwd,
            scope,
            input: { text, source: 'tool', isOwner: true, isPrivate: true }
          })
          if (result.ok !== true) return { ok: false, message: result.reason ?? '写入失败' }
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
            if (hitIds.length > 0 && touchRecords(entry.card, hitIds) > 0) entry.save()
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
            if (removed === null) continue
            entry.save()
            note('tool', `忘掉一条（${entry.label}）：${removed.text.slice(0, 40)}`)
            return { ok: true, message: `忘掉了：${removed.text.slice(0, 40)}` }
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
              entry.save()
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
          savePurposeState(state)
          return { ok: true, message: `记下了，你会惦记着：${result.goal.text}` }
        }

        if (action === 'done') {
          const id = String(args?.id ?? '').trim()
          if (id === '') return { ok: false, message: 'id 不能为空（先 list 拿 id）' }
          if (!closeGoal(state, id)) return { ok: false, message: `没找到 id=${id} 的目标` }
          savePurposeState(state)
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
