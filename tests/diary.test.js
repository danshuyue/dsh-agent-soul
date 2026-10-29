/**
 * 日记测试：node tests/diary.test.js
 *
 * 覆盖：
 *   ① 时间工具：todayKey / parseDateLocal / scheduleMinutes / diaryDayBoundaries
 *   ② 对话扫描：collectForDiary（独立游标、跳过注入消息、收 assistant）
 *   ③ 对话读取：readDiaryConversations（22:00 分界裁剪、两天文件合并）
 *   ④ 补写：findMissingDay（只找最近一个缺失日）
 *   ⑤ 触发消息：composeTriggerMessage（包含摘要、日记路径、分步指令）
 *   ⑥ 清理：cleanupOldJsonl
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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
  composeTriggerMessage,
  cleanupOldJsonl,
  readRecentDiaries,
  resetDiaryCursor
} = diary

const { diaryJsonlPath, diaryPublicPath, diaryPrivatePath, ensureDirs } = await import('../lib/paths.js')
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

// diaryDayBoundaries：22:00 分界
{
  const { start, end } = diaryDayBoundaries('2026-10-29', 22 * 60)
  const startD = new Date(start)
  const endD = new Date(end)
  ok(startD.getFullYear() === 2026 && startD.getMonth() === 9 && startD.getDate() === 28, 'start 是前一天')
  ok(startD.getHours() === 22, `start 在 22 点（实际 ${startD.getHours()}）`)
  ok(endD.getFullYear() === 2026 && endD.getMonth() === 9 && endD.getDate() === 29, 'end 是当天')
  ok(endD.getHours() === 22, `end 在 22 点（实际 ${endD.getHours()}）`)
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

// 造两个 JSONL 文件（昨天 + 今天），验证 22:00 分界
{
  ensureDirs()

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = todayKey(today.getTime())
  const yesterdayStr = todayKey(today.getTime() - 24 * 60 * 60 * 1000)

  // 昨天的 JSONL：22:00 之前（不算今天）+ 22:00 之后（算今天）
  const yesterday22 = today.getTime() - 2 * 60 * 60 * 1000 // 昨天 22:00
  const yesterday21 = today.getTime() - 3 * 60 * 60 * 1000 // 昨天 21:00
  writeFileSync(
    diaryJsonlPath(yesterdayStr),
    JSON.stringify({ t: yesterday21, role: 'user', text: '昨天的旧消息', src: 'user' }) + '\n'
    + JSON.stringify({ t: yesterday22, role: 'user', text: '昨晚十点的消息', src: 'user' }) + '\n',
    'utf8'
  )

  // 今天的 JSONL：22:00 之前（算今天）+ 22:00 之后（不算今天）
  const today21 = today.getTime() + 21 * 60 * 60 * 1000 // 今天 21:00
  const today22 = today.getTime() + 22 * 60 * 60 * 1000 // 今天 22:00
  writeFileSync(
    diaryJsonlPath(todayStr),
    JSON.stringify({ t: today21, role: 'user', text: '今天晚上的消息', src: 'user' }) + '\n'
    + JSON.stringify({ t: today22, role: 'user', text: '今天十点后的消息', src: 'user' }) + '\n',
    'utf8'
  )

  const text = readDiaryConversations(todayStr, 22 * 60)

  ok(text.includes('昨晚十点的消息'), '昨天的 22:00 消息包含在日记日内')
  ok(text.includes('今天晚上的消息'), '今天的 21:00 消息包含在日记日内')
  ok(!text.includes('昨天的旧消息'), '昨天的 21:00 消息被排除（在分界线之前）')
  ok(!text.includes('今天十点后的消息'), '今天的 22:00 消息被排除（在分界线之后）')
}

// ---------------------------------------------------------------------------
console.log('补写（findMissingDay）')
// ---------------------------------------------------------------------------

// 没有任何日记：昨天就是缺失日
{
  const today = todayKey()
  const missing = findMissingDay(today, 7)
  ok(missing !== null, '没有日记时找到缺失日')
}

// 昨天有日记、前天没有：只补前天？不，只找最近的 → 前天
{
  ensureDirs()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = todayKey(today.getTime())
  const yesterdayStr = todayKey(today.getTime() - 24 * 60 * 60 * 1000)
  const dayBeforeStr = todayKey(today.getTime() - 2 * 24 * 60 * 60 * 1000)

  // 昨天有日记
  writeFileSync(diaryPrivatePath(yesterdayStr), '【私密】\n2026-10-28\ntest', 'utf8')

  // 前天没有日记
  const missing = findMissingDay(todayStr, 7)
  // 今天不算（findMissingDay 从 1 开始，即昨天），昨天有 → 继续往前找
  // 前天没有 → 返回前天
  ok(missing === dayBeforeStr, `昨天有日记、前天没有 → 补前天（实际 ${missing}，期望 ${dayBeforeStr}）`)

  // 清理
  rmSync(diaryPrivatePath(yesterdayStr))
}

// 最近 7 天都有日记：没有缺失日
{
  ensureDirs()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = todayKey(today.getTime())

  for (let i = 1; i <= 7; i++) {
    const key = todayKey(today.getTime() - i * 24 * 60 * 60 * 1000)
    writeFileSync(diaryPrivatePath(key), '【私密】\ntest', 'utf8')
  }

  const missing = findMissingDay(todayStr, 7)
  ok(missing === null, '最近 7 天都有日记 → 没有缺失日')

  // 清理
  for (let i = 1; i <= 7; i++) {
    const key = todayKey(today.getTime() - i * 24 * 60 * 60 * 1000)
    rmSync(diaryPrivatePath(key))
  }
}

// ---------------------------------------------------------------------------
console.log('触发消息（composeTriggerMessage）')
// ---------------------------------------------------------------------------

{
  const config = {
    diaryPublicTone: '温暖但克制',
    diaryPrivateTone: '真实、不设防'
  }
  const message = composeTriggerMessage(config, '2026-10-29', '今天聊了很多', {
    public: '【公开】\n2026-10-28\n昨天……',
    all: '【公开】\n2026-10-28\n昨天……\n\n---\n\n【私密】\n2026-10-28\n内绪……'
  })

  ok(message.includes('今天是 2026-10-29'), '包含日期')
  ok(message.includes('今天聊了很多'), '包含摘要')
  ok(message.includes('【第一步：写公开日记】'), '包含公开步骤')
  ok(message.includes('【第二步：写私密日记】'), '包含私密步骤')
  ok(message.includes('diary') || message.includes('public'), '包含文件路径')
  ok(message.includes('温暖但克制'), '包含公开语气')
  ok(message.includes('真实、不设防'), '包含私密语气')
  ok(message.includes('今天没有对话'), '包含无对话提示')
}

// 公开段只带公开日记，私密段带全部（不能把私密日记喂给公开那一步）
{
  const message = composeTriggerMessage({}, '2026-10-29', '今天聊了很多', {
    public: '【公开】\n2026-10-28\n只该出现在公开段',
    all: '【公开】\n2026-10-28\n只该出现在公开段\n\n---\n\n【私密】\n2026-10-28\n只该出现在私密段'
  })
  const pubStart = message.indexOf('【第一步：写公开日记】')
  const privStart = message.indexOf('【第二步：写私密日记】')
  const publicSeg = message.slice(0, privStart)
  ok(pubStart >= 0 && pubStart < privStart, '公开步骤在私密步骤之前')
  ok(publicSeg.includes('只该出现在公开段'), '公开段带公开日记')
  ok(!publicSeg.includes('只该出现在私密段'), '公开段不带私密日记')
  ok(message.slice(privStart).includes('只该出现在私密段'), '私密段带私密日记')
}

// 空语气：不出现「语气：」行
{
  const message = composeTriggerMessage({}, '2026-10-29', '今天没有对话', { public: '', all: '' })
  ok(!message.includes('语气：'), '空语气不输出语气行')
}

// ---------------------------------------------------------------------------
console.log('最近日记（readRecentDiaries）')
// ---------------------------------------------------------------------------

{
  ensureDirs()
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // 昨天有公开 + 私密
  const yesterdayStr = todayKey(today.getTime() - 24 * 60 * 60 * 1000)
  writeFileSync(diaryPublicPath(yesterdayStr), '【公开】\n2026-10-28\npub', 'utf8')
  writeFileSync(diaryPrivatePath(yesterdayStr), '【私密】\n2026-10-28\npriv', 'utf8')

  const result = readRecentDiaries(todayKey(today.getTime()), 4)

  ok(result.public.includes('【公开】'), 'public 只包含公开日记')
  ok(!result.public.includes('【私密】'), 'public 不包含私密日记')
  ok(result.all.includes('【公开】'), 'all 包含公开日记')
  ok(result.all.includes('【私密】'), 'all 包含私密日记')

  // 清理
  rmSync(diaryPublicPath(yesterdayStr))
  rmSync(diaryPrivatePath(yesterdayStr))
}

// ---------------------------------------------------------------------------
console.log('清理（cleanupOldJsonl）')
// ---------------------------------------------------------------------------

{
  ensureDirs()
  const old = new Date()
  old.setDate(old.getDate() - 10) // 10 天前
  const oldKey = todayKey(old.getTime())
  const recentKey = todayKey()

  writeFileSync(diaryJsonlPath(oldKey), 'old data\n', 'utf8')
  writeFileSync(diaryJsonlPath(recentKey), 'recent data\n', 'utf8')

  const deleted = cleanupOldJsonl(5) // 保留 5 天

  ok(deleted >= 1, `删除了旧文件（实际 ${deleted}）`)
  ok(!exists(diaryJsonlPath(oldKey)), '旧 JSONL 已删除')
  ok(exists(diaryJsonlPath(recentKey)), '新 JSONL 保留')
}

// ---------------------------------------------------------------------------
console.log('摘要（summarizeConversations）')
// ---------------------------------------------------------------------------

const { summarizeConversations } = diary

// 没有 llm 服务 → 返回 null（调用方用原文兜底）
{
  const r = await summarizeConversations(null, '今天聊了天', {}, null)
  ok(r === null, '没有 llm 返回 null（交给调用方兜底）')
}

// 空对话 → 返回空串，不调模型
{
  const r = await summarizeConversations({ stream: function () { throw new Error('不该被调用') } }, '   ', {}, null)
  ok(r === '', '空对话直接返回空串，不调模型')
}

// 有 llm 但找不到模型目标 → null
{
  const r = await summarizeConversations({ stream: async function* () {} }, '有内容', {}, null)
  ok(r === null, '没有模型目标返回 null')
}

// 正常流式返回 → 截断到 maxSummaryChars
{
  const llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '摘要内容' }
    }
  }
  const agent = { options: { provider: 'p', model: 'm' } }
  const r = await summarizeConversations(llm, '有内容', { diaryMaxSummaryChars: 3 }, agent)
  ok(r === '摘要内容'.slice(0, 3), `摘要按 maxSummaryChars 截断（实际 ${r}）`)
}

// ---------------------------------------------------------------------------
console.log('参考天数（readRecentDiaries 边界）')
// ---------------------------------------------------------------------------

// days=1 只读昨天
{
  ensureDirs()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const y = todayKey(today.getTime() - 24 * 60 * 60 * 1000)
  const d2 = todayKey(today.getTime() - 2 * 24 * 60 * 60 * 1000)
  writeFileSync(diaryPublicPath(y), '【公开】\ny1\n(yesterday)', 'utf8')
  writeFileSync(diaryPublicPath(d2), '【公开】\ny2\n(two days ago)', 'utf8')

  const r1 = readRecentDiaries(todayKey(today.getTime()), 1)
  ok(r1.public.includes('(yesterday)'), 'days=1 读到昨天')
  ok(!r1.public.includes('(two days ago)'), 'days=1 读不到前天')

  rmSync(diaryPublicPath(y))
  rmSync(diaryPublicPath(d2))
}

// ---------------------------------------------------------------------------
console.log(`\n结果：${passed} 通过，${failed} 失败`)
// ---------------------------------------------------------------------------
process.exitCode = failed === 0 ? 0 : 1
