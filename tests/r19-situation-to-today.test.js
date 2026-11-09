/**
 * R19 · 现实情境（④）+「昨天想对今天说的话」（⑥）
 *
 * 两项都是「派生 / 旁路」：不新增状态源、不新增模型调用、各带一个总开关。
 * 测试重点是「关掉之后逐字节等价」与「不写就不写」—— 那两条最容易在实现里被顺手破坏。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r19-'))
process.env.DSH_HOME = sandbox
process.env.TZ = 'UTC'
mkdirSync(join(sandbox, 'agents'), { recursive: true })

let passed = 0
let failed = 0
const ok = (c, n) => { if (c) { passed += 1; console.log(`  ✓ ${n}`) } else { failed += 1; console.error(`  ✗ ${n}`) } }
const eq = (a, e, n) => ok(JSON.stringify(a) === JSON.stringify(e), `${n}${JSON.stringify(a) === JSON.stringify(e) ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(e)}）`}`)

const paths = await imp('paths.js')
const situation = await imp('core/situation.js')
const toToday = await imp('diary/to-today.js')
const inject = await imp('host/runtime/inject.js')
const evidence = await imp('evidence.js')
paths.ensureDirs()

// ---------------------------------------------------------------------------
console.log('④ 时段 / 季节 / 节日（纯计算）')
// ---------------------------------------------------------------------------
eq(situation.periodOf(0), 'late-night', '0 点是深夜')
eq(situation.periodOf(4), 'late-night', '4 点仍是深夜')
eq(situation.periodOf(5), 'early-morning', '5 点清晨')
eq(situation.periodOf(8), 'morning', '8 点上午')
eq(situation.periodOf(12), 'afternoon', '12 点下午')
eq(situation.periodOf(18), 'evening', '18 点晚上')
eq(situation.periodOf(23), 'late-night', '23 点深夜')
eq(situation.periodOf(NaN), 'day', 'NaN 退回 day（不炸）')
eq(situation.seasonOf(4), '春', '4 月春')
eq(situation.seasonOf(7), '夏', '7 月夏')
eq(situation.seasonOf(10), '秋', '10 月秋')
eq(situation.seasonOf(1), '冬', '1 月冬')

{
  const s = situation.situationOf(new Date(2026, 10, 9, 1, 30).getTime(), {
    holidays: { '11-09': '测试节' },
    daysAgo: 3
  })
  eq(s.period, 'late-night', '深夜')
  eq(s.holiday, '测试节', '自定义节日表生效')
  ok(s.facts.includes('今天是测试节'), 'facts 里有节日')
  ok(s.facts.includes('已经 3 天没聊过了'), 'facts 里有久未交互')
  ok(s.facts.includes('现在是深夜'), 'facts 里有时段')
  eq(situation.briefOf(s), '已经 3 天没聊过了，今天是测试节', 'brief 优先「久未聊 + 节日」，不带时段（最多两句）')

  const noPeriod = situation.situationOf(new Date(2026, 10, 9, 1, 30).getTime(), {
    holidays: {},
    withPeriod: false
  })
  ok(!noPeriod.facts.some((f) => f.startsWith('现在是')), 'withPeriod:false 不带时段（日记按整天算）')
  ok(noPeriod.facts.includes('11 月·秋'), '仍然带月份与季节')
}

// 节日表写坏 → 用内置默认，不抛错
{
  writeFileSync(paths.situationHolidaysPath(), '{ 这不是 JSON', 'utf8')
  const table = situation.loadHolidays()
  eq(table['10-01'], '国庆', '坏文件退回内置默认')
  writeFileSync(paths.situationHolidaysPath(), JSON.stringify({ '03-08': '妇女节' }), 'utf8')
  const custom = situation.loadHolidays()
  eq(custom['03-08'], '妇女节', '自定义表覆盖')
  eq(custom['10-01'], undefined, '自定义表是**替换**而不是合并（用户能删掉不想要的节日）')
  writeFileSync(paths.situationHolidaysPath(), '{}', 'utf8')
  eq(situation.loadHolidays()['01-01'], '元旦', '空对象 → 退回默认')
}

// ---------------------------------------------------------------------------
console.log('⑥ 解析：从私密正文里取那一行')
// ---------------------------------------------------------------------------
eq(toToday.parseToToday('今天聊了很多。\n\n想对明天说：明天试着把"不吵"换成"我在"'),
  '明天试着把"不吵"换成"我在"', '标准写法')
eq(toToday.parseToToday('想对明天说：早点睡'), '早点睡', '只有一个标记行')
eq(toToday.parseToToday('> 想对明天说：试着先听完'), '试着先听完', '引用前缀也能认')
eq(toToday.parseToToday('- 想对明天说：少解释一点'), '少解释一点', '列表前缀也能认')
eq(toToday.parseToToday('今天没有那句话'), '', '没有标记 → 空')
eq(toToday.parseToToday(''), '', '空正文 → 空')
eq(toToday.parseToToday('想对明天说：\n还有正文'), '', '标记后面空 → 空（不硬凑）')
eq(toToday.parseToToday('想对明天说：第一句\n想对明天说：第二句'), '第二句', '多行标记取最后一条')

// ---------------------------------------------------------------------------
console.log('⑥ 收窄：字数上限')
// ---------------------------------------------------------------------------
{
  const long = '一'.repeat(40)
  eq(toToday.normalizeToToday(long, 30).ok, false, '超过 30 字不接受')
  ok(String(toToday.normalizeToToday(long, 30).reason).includes('30'), '原因里说了上限')
  eq(toToday.normalizeToToday(' 明天试着少解释一点 ', 30).text, '明天试着少解释一点', '去掉首尾空白')
  eq(toToday.normalizeToToday('', 30).ok, false, '空 → 不接受')
}

// ---------------------------------------------------------------------------
console.log('⑥ 落盘与跨天作废')
// ---------------------------------------------------------------------------
{
  const saved = toToday.saveToToday('2026-11-09', '明天试着把"不吵"换成"我在"', { source: 'private-diary' })
  eq(saved.ok, true, '写盘成功')
  const read = toToday.readToToday('2026-11-09')
  eq(read.text, '明天试着把"不吵"换成"我在"', '当天读得到')
  eq(read.source, 'private-diary', '来源记下来了')
  eq(toToday.readToToday('2026-11-10'), null, '换一天读不到（跨天作废，不需要清理任务）')
  eq(toToday.saveToToday('2026-11-09', '', {}).ok, false, '空正文不写')
  eq(toToday.saveToToday('bad-date', 'x', {}).ok, false, '非法日期不写')
  eq(toToday.clearToToday().ok, true, '能删掉')
  eq(toToday.readToToday('2026-11-09'), null, '删掉之后读不到')
}

// ---------------------------------------------------------------------------
console.log('⑥ 注入：只在新会话首轮出现一次')
// ---------------------------------------------------------------------------
{
  // 今天以 mock 的时间为准：inject 用的是 todayKey(Date.now())，所以要用真实今天
  const tonight = (await imp('diary/completion.js')).todayKey(Date.now())
  toToday.saveToToday(tonight, '明天试着把"不吵"换成"我在"', { source: 'private-diary' })

  const cfgOn = { memoryRecentDiaryDays: 0, memoryRecentChatChars: 0, diaryToTodayEnabled: true }
  const withLine = inject.renderRecentSection(cfgOn)
  ok(withLine.includes('昨天想对今天说的'), '开着的时候有这一节')
  ok(withLine.includes('明天试着把"不吵"换成"我在"'), '那一句真的进了上下文')

  const cfgOff = { ...cfgOn, diaryToTodayEnabled: false }
  const withoutLine = inject.renderRecentSection(cfgOff)
  eq(withoutLine, '', '关掉 → 逐字节等价（空串，不是「有标题没内容」）')

  const cfgOtherDay = { ...cfgOn }
  toToday.clearToToday()
  eq(inject.renderRecentSection(cfgOtherDay), '', '今天没有这句 → 不出现这一节（不留空标题）')
}

// ---------------------------------------------------------------------------
console.log('⑥ 开关证据：报告里能看见它')
// ---------------------------------------------------------------------------
{
  const tonight = (await imp('diary/completion.js')).todayKey(Date.now())
  const cfg = { enabled: true, diaryEnabled: true, diaryToTodayEnabled: true, situationEnabled: true }

  toToday.clearToToday()
  const before = evidence.statuses(cfg, {}).find((r) => r.key === 'diaryToTodayEnabled')
  eq(before.status, '暂无', '今天还没写 → 暂无（不是「未生效」，也不是「生效」）')

  toToday.saveToToday(tonight, '早点睡', {})
  const after = evidence.statuses(cfg, {}).find((r) => r.key === 'diaryToTodayEnabled')
  eq(after.status, '生效', '写了之后 → 生效')

  const off = evidence.statuses({ ...cfg, diaryToTodayEnabled: false }, {}).find((r) => r.key === 'diaryToTodayEnabled')
  eq(off.status, '未生效', '关掉 → 未生效')
  ok(String(off.reason).includes('关'), '原因说人话')

  const sit = evidence.statuses({ ...cfg, situationEnabled: false }, {}).find((r) => r.key === 'situationEnabled')
  eq(sit.status, '未生效', '情境关掉也进报告')
}

// ---------------------------------------------------------------------------
console.log('⑥ 端到端：她自己写私密日记 → 那一行被摘出来，正文一个字节没动')
// ---------------------------------------------------------------------------
{
  // 走真实调用路径（runDiaryOnce + 假 agent 写文件），不是直接调 parseToToday。
  // 这是 11-04 那条教训的应用：纯函数测试全绿、调用点死了三天没人知道。
  const store = await imp('store.js')
  const diary = await imp('diary.js')
  const { runDiaryOnce, writeDiaryFile } = diary
  const completion = await imp('diary/completion.js')

  const date = '2026-11-01'
  store.saveConfig({ diarySessionId: 'sess-r19', diaryAgentWrite: true, diaryAgentTimeoutMs: 800, diaryToTodayEnabled: true, diaryToTodayMaxChars: 30 })

  const marker = '想对明天说：明天试着把"不吵"换成"我在"'
  const asked = []
  const fakeAgent = {
    followup: (message) => {
      const text = String(message?.content?.[0]?.text ?? '')
      if (text.includes('kind=public')) { asked.push('public'); writeDiaryFile('public', date, '她写的公开日记') }
      else if (text.includes('kind=private')) {
        asked.push('private')
        // 她在私密正文末尾多写一行（这是 ⑥ 唯一需要的配合）
        writeDiaryFile('private', date, `她写的私密日记，写了很多心里话。\n\n${marker}`)
      }
    }
  }
  const ctx = {
    agents: { get: (id) => (id === 'sess-r19' ? fakeAgent : undefined) },
    llm: { stream: async function* () { throw new Error('不该走兜底') } }
  }

  toToday.clearToToday()
  const done = await runDiaryOnce(ctx, date, undefined, { since: Date.now() + 5000 })
  eq(done, true, '日记整体成功')
  eq(asked.length, 2, '公开与私密都投递了')

  const today = completion.todayKey(Date.now())
  const stored = toToday.readToToday(today)
  ok(stored !== null, '那一句按「今天」存下来了')
  eq(stored?.text, '明天试着把"不吵"换成"我在"', '内容正确')
  eq(stored?.source, 'private-diary', '来源标记正确')

  // 私密正文必须**原样保留**那一行 —— 我们只解析、不改写
  const privateBody = (await import('node:fs')).readFileSync(paths.diaryPrivatePath(date), 'utf8')
  ok(privateBody.includes(marker), '私密正文里那一行还在（从不改写正文）')
  ok(privateBody.includes('她写的私密日记'), '正文主体没被动过')
}

// ---------------------------------------------------------------------------
console.log('界面：两个开关都在设置页里，卡片不是「有才显示」')
// ---------------------------------------------------------------------------
{
  // 2026-11-09 修：第一版只在「今天有那句」时才渲染卡片，用户在设置页什么都没看到，
  // 以为功能没做。这条断言把「卡片与开关必须在客户端产物里」钉住。
  const { readFileSync } = await import('node:fs')
  const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
  ok(bundle.includes('昨天想对今天说的'), '客户端产物里有这张卡片')
  ok(bundle.includes('diaryToTodayEnabled'), '卡片旁边有开关')
  ok(bundle.includes('situationEnabled'), '现实情境也有开关')
  ok(bundle.includes('今天还没有这一句'), '没有这句时给的是轻说明，不是整块消失')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
