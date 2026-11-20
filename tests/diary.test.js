/**
 * 摘录测试：node tests/diary.test.js
 *
 * 覆盖：
 *   ① 时间工具：todayKey / parseDateLocal / scheduleMinutes / diaryDayBoundaries
 *   ② 对话扫描：collectForDiary（独立游标、跳过注入消息、收 assistant）
 *   ③ 对话读取：readDiaryConversations（自然日裁剪、两天文件合并）
 *   ④ 补写：findMissingDay（没写过摘录不补、没对话的日子不补）
 *   ⑤ 触发消息：composeExcerptMessage（一条、一篇、不写感受）
 *   ⑥ 等待落盘：waitForWrite
 *   ⑦ 最近摘录：readRecentExcerpts
 *   ⑧ 绑定会话：diaryAgent
 *
 * 用例里的事件形状全部照真机来：user 正文在 data.content，
 * assistant 正文在 data.message.content（多一层 message）。
 *
 * 2026-11-21 / 0.10.0：日记 → 摘录。原来这里测的「公开/私密两条消息」、
 * 「私密查看闸门」、以及废弃的 summarizeConversations 都随功能删掉了。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

// 临时 DSH_HOME：所有文件写这里
const sandbox = mkdtempSync(join(tmpdir(), 'soul-diary-'))
process.env.DSH_HOME = sandbox

const diary = await import('../lib/diary.js')
const {
  todayKey,
  parseDateLocal,
  scheduleMinutes,
  diaryDayBoundaries,
  collectForDiary,
  readDiaryConversations,
  findMissingDay,
  composeExcerptMessage,
  waitForWrite,
  readRecentExcerpts,
  renderRecentExcerpts,
  resetDiaryCursor,
  writeExcerptFile,
  diaryAgent
} = diary

const { diaryJsonlPath, diaryExcerptPath, ensureDirs } = await import('../lib/paths.js')
const { exists } = await import('../lib/paths.js')

// ---------------------------------------------------------------------------
console.log('时间工具')
// ---------------------------------------------------------------------------

// todayKey：YYYY-MM-DD 格式
{
  const key = todayKey(new Date(2026, 9, 29, 14, 30).getTime())
  ok(key === '2026-10-29', `todayKey 返回 YYYY-MM-DD（实际 ${key}）`)
}

// parseDateLocal：本地零点
{
  const d = parseDateLocal('2026-10-29')
  ok(d.getFullYear() === 2026 && d.getMonth() === 9 && d.getDate() === 29, 'parseDateLocal 解析年月日')
  ok(d.getHours() === 0 && d.getMinutes() === 0, 'parseDateLocal 是零点')
}

// parseDateLocal：坏字符串返回 NaN
{
  const d = parseDateLocal('not-a-date')
  ok(Number.isNaN(d.getTime()), 'parseDateLocal 坏输入返回 NaN')
}

// scheduleMinutes：'22:00' → 1320
{
  const sm = scheduleMinutes('22:00')
  ok(sm === 22 * 60, `scheduleMinutes('22:00') = 1320（实际 ${sm}）`)
}

// scheduleMinutes：坏格式回退默认值
{
  const sm = scheduleMinutes('abc')
  ok(sm === 22 * 60, `scheduleMinutes('abc') 回退 1320（实际 ${sm}）`)
}

// diaryDayBoundaries：自然日（2026-11-01 起不再用 22:00 分界）
{
  const { start, end } = diaryDayBoundaries('2026-10-29', 22 * 60)
  const startD = new Date(start)
  const endD = new Date(end)
  ok(startD.getFullYear() === 2026 && startD.getMonth() === 9 && startD.getDate() === 29, 'start 是当天 00:00')
  ok(startD.getHours() === 0, `start 在 0 点（实际 ${startD.getHours()}）`)
  ok(endD.getFullYear() === 2026 && endD.getMonth() === 9 && endD.getDate() === 30, 'end 是次日 00:00')
  ok(endD.getHours() === 0, `end 在 0 点（实际 ${endD.getHours()}）`)
  // 第二个参数只为兼容保留：传什么值都不该改变结果
  const alt = diaryDayBoundaries('2026-10-29', 0)
  ok(alt.start === start && alt.end === end, 'scheduleMinutes 不再影响边界')
}

// diaryDayBoundaries：坏日期返回 0
{
  const { start } = diaryDayBoundaries('not-a-date', 22 * 60)
  ok(start === 0, 'diaryDayBoundaries 坏日期返回 0')
}

// ---------------------------------------------------------------------------
console.log('对话扫描（collectForDiary）')
// ---------------------------------------------------------------------------

// 造一个和真机一样的 agent
function makeAgent(events) {
  return {
    session: {
      header: { id: 'session-diary-test' },
      get seq() {
        return events.length > 0 ? events[events.length - 1].seq : 0
      },
      snapshotEvents(from, to) {
        return events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
      }
    }
  }
}

const realEvent = (seq, type, text, kind) => ({
  type,
  seq,
  time: Date.now(),
  data: {
    content: [{ type: 'text', text }],
    source: { kind },
    role: type === 'user/message' ? 'user' : 'assistant',
    id: `id-${seq}`
  },
  surfaceOp: 'append'
})

// 第一次：初始化游标，不扫描
{
  resetDiaryCursor()
  const agent = makeAgent([])
  const result = collectForDiary(agent)
  ok(result.scanned === 0 && result.appended === 0, '第一次调用只初始化游标')
}

// 第二次：扫描新事件
{
  resetDiaryCursor()
  const events = [realEvent(1, 'user/message', '你好', 'user')]
  const agent = makeAgent(events)
  collectForDiary(agent) // 初始化游标

  // 追加新事件，重新造 agent（seq 是 getter，不能直接赋值）
  events.push(realEvent(2, 'user/message', '今天怎么样', 'user'))
  events.push(realEvent(3, 'assistant/message', '挺好的', 'model'))
  events.push(realEvent(4, 'user/message', 'runtime context', 'runtime-context')) // 应被跳过
  const agent2 = makeAgent(events)

  const result = collectForDiary(agent2)
  // seq 2,3 被扫描；4 是 runtime-context 被跳过
  ok(result.appended === 2, `扫描到 2 条有效消息（实际 ${result.appended}）`)

  // 验证 JSONL 文件内容
  const file = diaryJsonlPath(todayKey())
  ok(exists(file), 'JSONL 文件已创建')
}

// 真机 assistant/message：正文在 data.message.content（**有** message 这一层），
// 且绝大多数条目只有 reasoning —— 摘录要记的是她说出口的话，不是心里想的
{
  const realAssistantEvent = (seq, blocks) => ({
    type: 'assistant/message',
    seq,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { role: 'assistant', content: blocks }, usage: {}, stream: {} },
    surfaceOp: 'append'
  })

  resetDiaryCursor()
  const events = [realEvent(1, 'user/message', '你好', 'user')]
  collectForDiary(makeAgent(events))

  events.push(
    realAssistantEvent(2, [{ type: 'reasoning', text: '让我想想路径对不对，D:\\software\\deepseek\\...' }]),
    realAssistantEvent(3, [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{}' }]),
    realAssistantEvent(4, [
      { type: 'reasoning', text: '再想一遍' },
      { type: 'text', text: '我今天挺开心的' }
    ])
  )
  const result = collectForDiary(makeAgent(events))
  ok(result.appended === 1, `只有真正在说话的那条进流水（实际 ${result.appended}）`)

  const lines = readFileSync(diaryJsonlPath(todayKey()), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const last = lines[lines.length - 1]
  ok(last.role === 'assistant' && last.text.includes('我今天挺开心的'), `记的是她说的话（实际「${last.text}」）`)
  ok(!last.text.includes('让我想想') && !last.text.includes('再想一遍'), '不含思考过程')
  ok(!last.text.includes('pwsh'), '不含工具调用')
}

// runtime-context 应被跳过
{
  resetDiaryCursor()
  const events = [realEvent(1, 'user/message', 'hello', 'user')]
  const agent = makeAgent(events)
  collectForDiary(agent)

  events.push(realEvent(2, 'user/message', 'should skip this', 'runtime-context'))
  events.push(realEvent(3, 'user/message', 'real message', 'user'))
  const agent2 = makeAgent(events)
  const result = collectForDiary(agent2)
  ok(result.appended === 1, 'runtime-context 被跳过')
}

// ---------------------------------------------------------------------------
console.log('对话读取（readDiaryConversations）')
// ---------------------------------------------------------------------------

// 造两个 JSONL 文件（昨天 + 今天），验证自然日切分
{
  ensureDirs()

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = todayKey(today.getTime())
  const yesterdayStr = todayKey(today.getTime() - 24 * 60 * 60 * 1000)

  const yesterday21 = today.getTime() - 3 * 60 * 60 * 1000 // 昨天 21:00
  const yesterday22 = today.getTime() - 2 * 60 * 60 * 1000 // 昨天 22:00
  writeFileSync(
    diaryJsonlPath(yesterdayStr),
    JSON.stringify({ t: yesterday21, role: 'user', text: '昨天的旧消息', src: 'user' }) + '\n'
    + JSON.stringify({ t: yesterday22, role: 'user', text: '昨晚十点的消息', src: 'user' }) + '\n',
    'utf8'
  )

  const today00 = today.getTime() + 60 * 1000 // 今天 00:01
  const today21 = today.getTime() + 21 * 60 * 60 * 1000 // 今天 21:00
  const today22 = today.getTime() + 22 * 60 * 60 * 1000 // 今天 22:00
  writeFileSync(
    diaryJsonlPath(todayStr),
    JSON.stringify({ t: today00, role: 'user', text: '今早的消息', src: 'user' }) + '\n'
    + JSON.stringify({ t: today21, role: 'user', text: '今天晚上的消息', src: 'user' }) + '\n'
    + JSON.stringify({ t: today22, role: 'user', text: '今天十点后的消息', src: 'user' }) + '\n',
    'utf8'
  )

  const text = readDiaryConversations(todayStr, 22 * 60)

  // 自然日：今天 00:00 ~ 次日 00:00，深夜 22 点当然还在今天里面
  ok(text.includes('今早的消息'), '今天 00:01 的消息包含在这一天内')
  ok(text.includes('今天晚上的消息'), '今天 21:00 的消息包含在这一天内')
  ok(text.includes('今天十点后的消息'), '今天 22:00 的消息也包含（不再按 22 点切）')
  ok(!text.includes('昨天的旧消息'), '昨天的消息不在今天这一天里')
  ok(!text.includes('昨晚十点的消息'), '昨天 22:00 也不会被算进今天')

  // 反过来看昨天那一天：21 点和 22 点两条都在
  const yText = readDiaryConversations(yesterdayStr, 22 * 60)
  ok(yText.includes('昨天的旧消息') && yText.includes('昨晚十点的消息'), '昨天的两条都在昨天那一天里')
}

// ---------------------------------------------------------------------------
console.log('补写（findMissingDay）')
// ---------------------------------------------------------------------------

// 一篇摘录都没有（刚装上插件）：不补写 —— 补写是补断档，不是回溯历史
{
  const today = todayKey()
  const missing = findMissingDay(today, 7)
  ok(missing === null, '从未写过摘录 → 不补写')
}

// 昨天有摘录、前天有对话但没摘录：只补前天（最近的一个）
{
  ensureDirs()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = todayKey(today.getTime())
  const yesterdayStr = todayKey(today.getTime() - 24 * 60 * 60 * 1000)
  const dayBeforeStr = todayKey(today.getTime() - 2 * 24 * 60 * 60 * 1000)

  // 昨天「完整写过」= 摘录在，且 mtime 过了当天的窗口闭合（次日 00:00）。
  // 这里写文件的时间就是现在（今天），自然满足。
  writeExcerptFile(yesterdayStr, '- 昨天的事')
  // 前天有对话、没有摘录
  writeFileSync(diaryJsonlPath(dayBeforeStr), '{"t":1,"role":"user","text":"x"}\n', 'utf8')

  const missing = findMissingDay(todayStr, 7)
  // 今天不算（findMissingDay 从 1 开始，即昨天），昨天有 → 继续往前找
  // 前天没有摘录但有对话 → 返回前天
  ok(missing === dayBeforeStr, `昨天有摘录、前天有对话没摘录 → 补前天（实际 ${missing}，期望 ${dayBeforeStr}）`)

  // 清理
  rmSync(diaryExcerptPath(yesterdayStr))
  rmSync(diaryJsonlPath(dayBeforeStr))
}

// 缺失日没有对话：不补（补出来只能是空洞的条目）
{
  ensureDirs()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = todayKey(today.getTime())
  const dayBeforeStr = todayKey(today.getTime() - 2 * 24 * 60 * 60 * 1000)

  // 前置：清掉前面「对话读取」用例留下的 JSONL —— 不然测到的是「有对话」那条路
  for (let i = 1; i <= 7; i += 1) {
    const key = todayKey(today.getTime() - i * 24 * 60 * 60 * 1000)
    if (exists(diaryJsonlPath(key))) rmSync(diaryJsonlPath(key))
  }

  // 前提：已经写过摘录（否则走「从未写过 → 不补」那条，测不到这条判据）
  writeExcerptFile(dayBeforeStr, '- 一件旧事')

  const missing = findMissingDay(todayStr, 7)
  ok(missing === null, '缺失日没有对话 → 不补（实际 ' + missing + '）')

  rmSync(diaryExcerptPath(dayBeforeStr))
}

// 最近 7 天都有摘录：没有缺失日
{
  ensureDirs()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = todayKey(today.getTime())

  for (let i = 1; i <= 7; i++) {
    const key = todayKey(today.getTime() - i * 24 * 60 * 60 * 1000)
    writeExcerptFile(key, '- 事')
  }

  const missing = findMissingDay(todayStr, 7)
  ok(missing === null, '最近 7 天都有摘录 → 没有缺失日')

  // 清理
  for (let i = 1; i <= 7; i++) {
    const key = todayKey(today.getTime() - i * 24 * 60 * 60 * 1000)
    rmSync(diaryExcerptPath(key))
  }
}

// ---------------------------------------------------------------------------
console.log('触发消息（composeExcerptMessage）')
// ---------------------------------------------------------------------------

{
  const config = { diaryPublicTone: '平实、只写事实', excerptMaxLines: 15 }
  const msg = composeExcerptMessage(config, '2026-10-29', '今天聊了很多')

  ok(msg.includes('2026-10-29'), '消息包含日期')
  ok(msg.includes('今天聊了很多'), '消息包含素材')
  ok(msg.includes('平实、只写事实'), '消息带摘录语气')
  // 2026-11-04：不再给绝对路径了 —— 改成让她用 soul_diary 工具写。
  ok(msg.includes('soul_diary') && msg.includes('kind=excerpt'), '指明用 soul_diary 写（kind=excerpt）')
  ok(msg.includes('一行一条'), '写明格式：一行一条')
  ok(msg.includes('不写时间'), '写明不写时间')
  ok(msg.includes('觉得 / 看得出 / 其实 / 似乎 / 也许'), '写明禁止的感受词')
  ok(msg.includes('最多 15 条'), '写明上限条数')
  ok(msg.includes('（今天没有对话）'), '写明「没有对话」时写什么')
  ok(!msg.includes('私密'), '不再提私密那篇')
  ok(!msg.includes('公开那篇'), '不再提两篇的先后顺序')
}

// 空语气：不出现「语气：」行
{
  const msg = composeExcerptMessage({}, '2026-10-29', '今天没有对话')
  ok(!msg.includes('语气：'), '空语气不输出语气行')
  ok(msg.includes('今天没有对话'), '素材原样带着')
}

// 前几天的摘录作为参考，且明确「不是这一天的事」
{
  const msg = composeExcerptMessage({}, '2026-10-29', '素材', {
    recentExcerpts: [{ date: '2026-10-28', lines: ['昨天写了插件'] }]
  })
  ok(msg.includes('昨天写了插件'), '带上前几天的摘录')
  ok(msg.includes('不是这一天的事'), '明说那是前几天写的')
}

// waitForWrite：等她落盘用，等不到也不能卡死
{
  const neverFile = diaryExcerptPath('2099-01-01')
  const t0 = Date.now()
  const got = await waitForWrite(neverFile, 120, 50)
  ok(got === false, '等不到时返回 false')
  ok(Date.now() - t0 >= 120, '确实等满超时才返回')

  ensureDirs()
  const soonFile = diaryExcerptPath('2099-01-02')
  setTimeout(() => writeFileSync(soonFile, '# 2099-01-02\n\n- x\n', 'utf8'), 100)
  const got2 = await waitForWrite(soonFile, 3000, 50)
  ok(got2 === true, '文件被写入时能等到')
}

// ---------------------------------------------------------------------------
console.log('最近摘录（readRecentExcerpts）')
// ---------------------------------------------------------------------------

{
  ensureDirs()
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const yesterdayStr = todayKey(today.getTime() - 24 * 60 * 60 * 1000)
  writeExcerptFile(yesterdayStr, '- pub')

  const rows = readRecentExcerpts(todayKey(today.getTime()), 4)
  ok(rows.length === 1 && rows[0].date === yesterdayStr, '读到昨天那一篇')
  ok(rows[0].lines.includes('pub'), '条目读得出来')
  ok(renderRecentExcerpts(rows, { linesPerDay: 3 }).includes('pub'), '渲染成注入用的参考段')

  // 清理
  rmSync(diaryExcerptPath(yesterdayStr))
}

// ---------------------------------------------------------------------------
console.log('参考天数（readRecentExcerpts 边界）')
// ---------------------------------------------------------------------------

// days=1 只读昨天
{
  ensureDirs()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const y = todayKey(today.getTime() - 24 * 60 * 60 * 1000)
  const d2 = todayKey(today.getTime() - 2 * 24 * 60 * 60 * 1000)
  writeExcerptFile(y, '- (yesterday)')
  writeExcerptFile(d2, '- (two days ago)')

  const r1 = readRecentExcerpts(todayKey(today.getTime()), 1)
  ok(r1.some((row) => row.lines.includes('(yesterday)')), 'days=1 读到昨天')
  ok(!r1.some((row) => row.lines.includes('(two days ago)')), 'days=1 读不到前天')

  rmSync(diaryExcerptPath(y))
  rmSync(diaryExcerptPath(d2))
}

// ---------------------------------------------------------------------------
console.log('专属摘录会话（diaryAgent）')
// ---------------------------------------------------------------------------

const { saveConfig } = await import('../lib/store.js')
const { normalizeConfig } = await import('../lib/memory.js')
const { LOG_FILE } = await import('../lib/env.js')

function soulLog() {
  try {
    return exists(LOG_FILE()) ? readFileSync(LOG_FILE(), 'utf8') : ''
  } catch {
    return ''
  }
}

// 假 agent：session.snapshotEvents 提供「最后一条消息」，append 记录标题事件
function diaryFakeAgent(id, lastMessageAt = 0) {
  const appended = []
  return {
    session: {
      header: { id },
      appended,
      snapshotEvents() {
        return lastMessageAt > 0
          ? [{ type: 'user/message', seq: 1, time: lastMessageAt, data: {} }]
          : []
      },
      append(type, data) {
        appended.push({ type, data })
      }
    }
  }
}

// 假 ctx：agents 三级 + agentDefaultModel，calls 记录调用顺序与参数
function makeDiaryCtx({
  live = () => undefined,
  resume = async () => { throw new Error('resume 不可用') },
  create = async () => { throw new Error('create 不可用') },
  selection = { provider: 'deepseek', model: 'deepseek-chat' }
} = {}) {
  const calls = { get: [], resume: [], create: [] }
  const ctx = {
    agents: {
      get(id) {
        calls.get.push(id)
        return live(id)
      },
      async resume(options) {
        calls.resume.push(options)
        return resume(options)
      },
      async create(options) {
        calls.create.push(options)
        return create(options)
      }
    },
    agentDefaultModel: { currentSelection: () => selection }
  }
  return { ctx, calls }
}

// ① 未绑定：直接跳过，不碰 agents（更不 create）
{
  saveConfig({ excerptSessionId: '' })
  const before = soulLog().length
  const { ctx, calls } = makeDiaryCtx()
  const agent = await diaryAgent(ctx)
  ok(agent === undefined, '未绑定会话：返回 undefined')
  ok(calls.get.length === 0 && calls.resume.length === 0 && calls.create.length === 0, '未绑定会话：get/resume/create 都没调')
  ok(soulLog().slice(before).includes('没有绑定摘录会话'), '未绑定会留日志')
}

// ② get 命中：直接用活会话，不再 resume/create
{
  saveConfig({ excerptSessionId: 'session-my-diary' })
  const liveAgent = diaryFakeAgent('session-my-diary')
  const { ctx, calls } = makeDiaryCtx({ live: (id) => (id === 'session-my-diary' ? liveAgent : undefined) })
  const agent = await diaryAgent(ctx)
  ok(agent === liveAgent, 'get 命中时直接返回活会话')
  ok(calls.get[0] === 'session-my-diary', 'get 用的是绑定 id')
  ok(calls.resume.length === 0 && calls.create.length === 0, 'get 命中就不 resume/create')
}

// ③ get 未命中 → resume 绑定的 id
{
  saveConfig({ excerptSessionId: 'session-my-diary' })
  const resumed = diaryFakeAgent('session-my-diary')
  const { ctx, calls } = makeDiaryCtx({ resume: async () => ({ agent: resumed }) })
  const agent = await diaryAgent(ctx)
  ok(agent === resumed, 'get 未命中时冷启动拿到的 agent 被采用')
  ok(calls.resume.length === 1 && calls.resume[0].resumeSessionId === 'session-my-diary', '冷启动用绑定的 id')
  ok(calls.create.length === 0, '冷启动成功就不再 create')
}

// ④ 两级都失败：不创建、不猜、留原因（2026-10-31 的核心约束）
{
  saveConfig({ excerptSessionId: 'session-my-diary' })
  const before = soulLog().length
  const { ctx, calls } = makeDiaryCtx({
    live: () => { throw new Error('registry down') },
    resume: async () => { throw new Error('session not found') }
  })
  let threw = false
  let agent
  try {
    agent = await diaryAgent(ctx)
  } catch {
    threw = true
  }
  ok(threw === false && agent === undefined, '两级都失败：不抛异常，返回 undefined')
  ok(calls.create.length === 0, '两级都失败也绝不调用 agents.create')
  const log = soulLog().slice(before)
  ok(log.includes('绑定的日记会话不可用'), '两级都失败留下「绑定的日记会话不可用」日志')
  ok(log.includes('get 失败') && log.includes('resume 失败'), 'get / resume 的失败原因都留了日志')
}

// ⑤ 没有 agents 服务：跳过并说明
{
  saveConfig({ excerptSessionId: 'session-my-diary' })
  const agent = await diaryAgent({})
  ok(agent === undefined, '没有 agents 服务时返回 undefined')
}

// 配置归一
{
  ok(normalizeConfig({}).excerptSessionId === '', 'excerptSessionId 默认空串')
  ok(normalizeConfig({ excerptSessionId: '  session-a  ' }).excerptSessionId === 'session-a', 'excerptSessionId 去首尾空格')
  ok(normalizeConfig({ excerptSessionId: 123 }).excerptSessionId === '', 'excerptSessionId 非字符串回默认空串')
  ok(normalizeConfig({}).excerptMaxLines === 15, 'excerptMaxLines 默认 15')
  ok(normalizeConfig({ excerptMaxLines: 3 }).excerptMaxLines === 5, 'excerptMaxLines 低于下限夹到 5')
  ok(normalizeConfig({ excerptMaxLines: 999 }).excerptMaxLines === 60, 'excerptMaxLines 高于上限夹到 60')
}

// ---------------------------------------------------------------------------
console.log('旧配置迁移（diarySessionId → excerptSessionId）')
// ---------------------------------------------------------------------------

{
  const { writeFileSync: writeFile, rmSync: rm } = await import('node:fs')
  const { configPath } = await import('../lib/paths.js')
  const store = await import('../lib/store.js')

  ensureDirs()
  // 老配置：只有旧键，没有 excerptSessionId —— 升级后不能把绑定丢了
  writeFile(configPath(), JSON.stringify({
    ownerName: '树树',
    diarySessionId: 'session-legacy-old',
    diarySessionBornAt: 1_790_000_000_000
  }, null, 2), 'utf8')
  store.resetCaches()
  const migrated = store.loadConfig()
  ok(migrated.excerptSessionId === 'session-legacy-old', `旧 diarySessionId 被搬到 excerptSessionId（实际 ${migrated.excerptSessionId}）`)
  ok(migrated.excerptSessionBornAt === 1_790_000_000_000, '旧 bornAt 也一起搬过来')
  // 写回文件（只迁一次）：文件里应该已经出现新键
  const onDisk = JSON.parse(readFileSync(configPath(), 'utf8'))
  ok(onDisk.excerptSessionId === 'session-legacy-old', '迁移结果已写回 persona.json')

  // 新键存在时（哪怕是空串）→ 尊重用户，不再迁移
  writeFile(configPath(), JSON.stringify({
    excerptSessionId: '',
    diarySessionId: 'session-should-not-win'
  }, null, 2), 'utf8')
  store.resetCaches()
  ok(store.loadConfig().excerptSessionId === '', '已有新键时不再用旧键覆盖')

  rm(configPath(), { force: true })
  store.resetCaches()
}


// ---------------------------------------------------------------------------
console.log('回环判定（接口边界）')
// ---------------------------------------------------------------------------

const { isLoopbackRequest } = await import('../lib/api.js')

{
  ok(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }) === true, '回环判定：127.0.0.1 放行')
  ok(isLoopbackRequest({ socket: { remoteAddress: '::1' } }) === true, '回环判定：::1 放行')
  ok(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }) === true, '回环判定：::ffff:127.0.0.1 放行')
  ok(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.9' } }) === false, '回环判定：局域网地址拒绝')
  ok(isLoopbackRequest({}) === false, '回环判定：拿不到 remoteAddress 也拒绝')
}

// ---------------------------------------------------------------------------
console.log(`\n结果：${passed} 通过，${failed} 失败`)
// ---------------------------------------------------------------------------
mkdirSync(sandbox, { recursive: true })
process.exitCode = failed === 0 ? 0 : 1
