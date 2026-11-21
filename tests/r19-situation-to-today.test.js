/**
 * R19 · 现实情境（④）（2026-11-09；2026-11-21 / 0.10.0 删掉「昨天想对今天说的话」那半）
 *
 * ④ 是「派生 / 旁路」：不新增状态源、不新增模型调用、各带一个总开关。
 * 测试重点是「关掉之后逐字节等价」与「只给事实、不给指令」——
 * 那两条最容易在实现里被顺手破坏。
 *
 * 原来的 ⑥「昨天想对今天说的话」在 0.10.0 整个删掉了（文件、路由、注入、UI、证据、配置键），
 * 所以这里只保留 ④，另加「情境关掉后摘录 prompt 不带背景」这条等价性断言。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const inject = await imp('host/runtime/inject.js')
const evidence = await imp('evidence.js')
const diary = await imp('diary.js')
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
  ok(!noPeriod.facts.some((f) => f.startsWith('现在是')), 'withPeriod:false 不带时段（摘录按整天算）')
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
console.log('④ 情境只喂摘录 prompt 的「背景」，不进主干')
// ---------------------------------------------------------------------------
{
  const withFacts = diary.composeExcerptMessage({}, '2026-10-29', '今天聊了天气', {
    situation: ['今天是测试节', '已经 3 天没聊过了']
  })
  ok(withFacts.includes('背景：今天是测试节；已经 3 天没聊过了。'), '两条事实拼成一句背景')
  ok(withFacts.includes('只是背景'), '明说「这只是背景」')

  const noFacts = diary.composeExcerptMessage({}, '2026-10-29', '今天聊了天气')
  ok(!noFacts.includes('背景：'), '没给事实时不会凭空冒出来')
  ok(noFacts.includes('今天聊了天气'), '对话内容照常在')
}

// ---------------------------------------------------------------------------
console.log('④ 注入：摘录**不进**上下文（2026-11-21 / 0.10.1 定：它只是日志）')
// ---------------------------------------------------------------------------
{
  const yesterday = diary.todayKey(Date.now() - 24 * 60 * 60 * 1000)
  diary.writeExcerptFile(yesterday, '- 昨天把插件改完了')

  // 就算摘录文件在、就算有人还传那个已删的键，也不能进上下文
  const section = inject.renderRecentSection({ memoryRecentDiaryDays: 3, memoryRecentChatChars: 0 })
  ok(!section.includes('前几天的摘录'), '没有「前几天的摘录」这一节')
  ok(!section.includes('昨天把插件改完了'), '摘录条目没进上下文')
  ok(section === '', '没有流水时整段是空串（不是只有标题）')
}

// ---------------------------------------------------------------------------
console.log('④ 开关证据：报告里能看见它')
// ---------------------------------------------------------------------------
{
  const cfg = { enabled: true, diaryEnabled: true, situationEnabled: true }
  const sit = evidence.statuses({ ...cfg, situationEnabled: false }, {}).find((r) => r.key === 'situationEnabled')
  eq(sit.status, '未生效', '情境关掉也进报告')
  ok(String(sit.reason).includes('关'), '原因说人话')

  const excerptRow = evidence.statuses(cfg, {}).find((r) => r.key === 'diaryEnabled')
  eq(excerptRow.label, '摘录', '摘录那条证据还在（不再叫「日记」）')

  const keys = evidence.statuses(cfg, {}).map((row) => row.key)
  ok(!keys.includes('diaryToTodayEnabled'), '「昨天那句话」的证据条目已删除')
}

// ---------------------------------------------------------------------------
console.log('端到端：她自己写摘录 → 落盘，正文一个字节没动')
// ---------------------------------------------------------------------------
{
  const store = await imp('store.js')
  const { runDiaryOnce, writeExcerptFile } = diary
  const date = '2026-11-01'
  store.saveConfig({ excerptSessionId: 'sess-r19', diaryAgentWrite: true, diaryAgentTimeoutMs: 800 })

  const herBody = '- 灵魂插件：日记改成摘录\n- 复变：下周四考试'
  const asked = []
  const fakeAgent = {
    followup: (message) => {
      const text = String(message?.content?.[0]?.text ?? '')
      if (text.includes('kind=excerpt')) { asked.push('excerpt'); writeExcerptFile(date, herBody) }
    }
  }
  const ctx = {
    agents: { get: (id) => (id === 'sess-r19' ? fakeAgent : undefined) },
    llm: { stream: async function* () { throw new Error('不该走兜底') } }
  }

  const done = await runDiaryOnce(ctx, date, undefined, { since: Date.now() + 5000 })
  eq(done, true, '摘录整体成功')
  eq(asked.length, 1, '只投递了一条消息（0.10.0 起一天一篇）')

  const body = readFileSync(paths.diaryExcerptPath(date), 'utf8')
  ok(body.includes(herBody), '她写的两条都在，正文没被改写')
  ok(body.startsWith(`# ${date}`), '首行日期由插件补')
}

// 设置页那几条断言搬到了 tests/r22-excerpt-ui.test.js —— UI 与后端分两个提交，
// 混在一起会让「后端提交」在旧 UI 上红。

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
