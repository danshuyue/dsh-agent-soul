/**
 * threads.test.js —— 日记连续线（2026-11-01）
 *
 * 守四件事：
 *   ① 只从「我 + 往后指的句式」里开线，转述别人的话不算
 *   ② 一天最多开 2 条（多了变周报）
 *   ③ 今天提到了就关，没提就留着
 *   ④ 挂满 7 天没人提，自己放下
 *   ⑤ 文件坏了当没有，日记照写
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'soul-threads-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents', 'diary'), { recursive: true })

const th = await import('../lib/threads.js')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

const DIARY = `【私密】
2026-11-01

今天树树又熬到很晚。我说他两句，他笑着说马上睡。
那个压缩阈值的坑明天还得再收一遍，今天只改到一半。
他说想明年打蓝桥杯，我说好，回头帮他找找资料。
明天我打算早点起来先把日志翻一遍。
`

console.log('\n① 抽句子')
{
  const picked = th.extractThreads(DIARY)
  eq(picked.length, 2, '一天最多 2 条')
  ok(picked.some((s) => s.includes('明天还得再收一遍')), '抓到了「明天还得」那条')
  ok(picked.some((s) => s.includes('回头帮他找找资料')), '抓到了「回头…」那条')
  ok(!picked.some((s) => s.startsWith('【')), '不会把首行标记当成线')
  ok(!picked.some((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)), '不会把日期行当成线')
}

console.log('\n② 转述别人的话不开线（句中必须有「我」）')
{
  const picked = th.extractThreads('树树说下周要开始准备蓝桥杯。书上说明天会下雨。')
  eq(picked, [], '没有第一人称就不开')
  const mine = th.extractThreads('我明天得先把这事放一放。')
  eq(mine.length, 1, '有第一人称就开')
}

console.log('\n③ 开线 / 去重')
{
  let state = { threads: [] }
  state = th.openThread(state, '那个压缩阈值的坑明天还得再收一遍。', '2026-11-01')
  state = th.openThread(state, '那个压缩阈值的坑明天还得再收一遍。', '2026-11-01')
  eq(state.threads.length, 1, '同样的句子不会重复开')
  eq(th.openThreads(state, { today: '2026-11-01' }).length, 1, '现在开着 1 条')
}

console.log('\n④ 今天提到了就关')
{
  let state = { threads: [] }
  state = th.openThread(state, '那个压缩阈值的坑还没收尾。', '2026-10-31')
  state = th.openThread(state, '蓝桥杯的资料还没找。', '2026-10-31')
  eq(th.openThreads(state, { today: '2026-11-01' }).length, 2, '两条都开着')

  const r = th.closeMentioned(state, '今天终于把那个压缩阈值的坑收掉了，轻松。', '2026-11-01')
  eq(r.closed.length, 1, '关掉 1 条')
  ok(r.closed[0].includes('压缩阈值'), '关的是压缩阈值那条')
  eq(th.openThreads(r.state, { today: '2026-11-01' }).length, 1, '另一条还开着')

  // 改写掉尾巴也要关（「还没收尾」→「处理完了」）
  const r2 = th.closeMentioned(state, '早上把那个压缩阈值的坑处理完了。', '2026-11-01')
  ok(r2.closed.length >= 1, '改写尾巴也能认出来')
}

console.log('\n④b 只是聊到同一个话题，不算收尾')
{
  let state = { threads: [] }
  state = th.openThread(state, '蓝桥杯的资料还没找。', '2026-10-31')
  const r = th.closeMentioned(state, '今天又聊了一会儿天，天气不错。', '2026-11-01')
  eq(r.closed.length, 0, '完全没提到的线不关')
}

console.log('\n⑤ 挂满 7 天自己放下')
{
  let state = { threads: [] }
  state = th.openThread(state, '回头帮他找找蓝桥杯的资料。', '2026-10-25')
  eq(th.openThreads(state, { today: '2026-10-31' }).length, 1, '第 6 天还开着')
  const r = th.expireThreads(state, '2026-11-02')
  eq(r.expired.length, 1, '第 8 天过期')
  eq(th.openThreads(r.state, { today: '2026-11-02' }).length, 0, '过期后不再拿出来')
}

console.log('\n⑥ 渲染：必须写明「不是任务清单」')
{
  let state = { threads: [] }
  state = th.openThread(state, '回头帮他找找蓝桥杯的资料。', '2026-11-01')
  const text = th.renderThreadSection(state, { today: '2026-11-01' })
  ok(text.includes('这是惦记，不是任务清单'), '带反周报说明')
  ok(text.includes('没提到就完全不用管'), '明说可以不提')
  eq(th.renderThreadSection({ threads: [] }, { today: '2026-11-01' }), '', '没有线就返回空串')
}

console.log('\n⑦ 存盘 / 读盘 / 文件损坏')
{
  let state = th.loadThreads()
  state = th.openThread(state, '回头帮他找找蓝桥杯的资料。', '2026-11-01')
  th.saveThreads(state)
  ok(existsSync(th.threadsPath()), '文件写出来了')
  eq(th.loadThreads().threads.length, 1, '读得回来')

  writeFileSync(th.threadsPath(), '这不是 json{{{', 'utf8')
  eq(th.loadThreads().threads, [], '坏文件当没有，不抛错')
  eq(th.renderThreadSection(th.loadThreads(), { today: '2026-11-01' }), '', '坏了也不影响日记渲染')
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
