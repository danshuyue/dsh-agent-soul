/**
 * 对话流水保留期回归（2026-11-05）：node tests/retention.test.js
 *
 * 这里最重要的不是「删得对」，而是「默认一个都不删」—— 动的是用户数据。
 * 清单式覆盖：命名白名单、今天/未来保护、天数边界、体积预算、dryRun、
 * 真实目录不误删、配置默认与透传、collectForDiary 挂点。
 * 全程临时 DSH_HOME，文件自造。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-retention-'))
process.env.DSH_HOME = HOME

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
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

const paths = await import('../lib/paths.js')
const store = await import('../lib/store.js')
const memory = await import('../lib/memory.js')
const diary = await import('../lib/diary.js')
const { planConversationPrune, pruneConversations, dateKeyOf, DAY_MS } = await import('../lib/retention.js')

paths.ensureDirs()
const TODAY = '2026-11-05'
const entry = (name, bytes = 100) => ({ name, bytes })

// ---------------------------------------------------------------------------
console.log('\n① 纯函数 · 默认与命名白名单：')
{
  const r = planConversationPrune([
    entry('2026-01-01.jsonl'), entry('2026-11-04.jsonl')
  ], { today: TODAY })
  eq([r.skipped, r.toDelete.length], [true, 0], '两个开关都是 0 → skipped，一个文件都不删')

  const mixed = [
    entry('2026-01-01.jsonl'), entry('2026-11-04.jsonl'),
    entry('2026-01-02.jsonl.bak'), entry('.corrupt-2026-01-01.jsonl'),
    entry('2026-01-01.md'), entry('notes.jsonl'), entry('2026-13-45.jsonl'),
    entry('2026-1-1.jsonl'), entry('subdir')
  ]
  const r2 = planConversationPrune(mixed, { today: TODAY, keepDays: 3 })
  eq(r2.toDelete.map((x) => x.name), ['2026-01-01.jsonl'], '只删严格的 YYYY-MM-DD.jsonl，其余一律不碰')
  eq(r2.kept.includes('2026-11-04.jsonl'), true, '窗口内的合法文件保留')
  eq(r2.totalBytes, 200, 'totalBytes 只统计合法日期文件')
}

// ---------------------------------------------------------------------------
console.log('\n② 纯函数 · 天数边界与今天/未来保护：')
{
  const all = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']
    .map((d) => entry(`${d}.jsonl`))
  const r = planConversationPrune(all, { today: TODAY, keepDays: 3 })
  eq(r.toDelete.map((x) => x.name), ['2026-11-01.jsonl', '2026-11-02.jsonl'], '保留最近 3 天 = 11-03/04/05，删更早的')
  eq(r.kept.includes('2026-11-05.jsonl'), true, '今天永不删（正在写的流水）')
  eq(r.kept.includes('2026-11-06.jsonl'), true, '未来日期永不删（时钟回拨也不误删）')
  eq(r.toDelete.every((x) => x.reason === 'retention'), true, '删除原因标记为 retention')

  const one = planConversationPrune(all, { today: TODAY, keepDays: 1 })
  eq(one.toDelete.map((x) => x.name), ['2026-11-01.jsonl', '2026-11-02.jsonl', '2026-11-03.jsonl', '2026-11-04.jsonl'], 'keepDays=1 → 只留今天与未来')
  eq(dateKeyOf(Date.parse('2026-11-05T00:00:00Z') - 2 * DAY_MS), '2026-11-03', 'cutoff 按 UTC 自然日算，不受本地时区影响')
}

// ---------------------------------------------------------------------------
console.log('\n③ 纯函数 · 体积预算：')
{
  const all = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']
    .map((d, i) => entry(`${d}.jsonl`, 100 + i))
  const r = planConversationPrune(all, { today: TODAY, maxBytes: 210 })
  // 总量 510；从最旧删：删 100→410、101→309、102→207，停。今天(104)不动。
  eq(r.toDelete.map((x) => x.name), ['2026-11-01.jsonl', '2026-11-02.jsonl', '2026-11-03.jsonl'], '从最旧的整天文件开始删到不超预算')
  eq(r.toDelete.every((x) => x.reason === 'budget'), true, '原因标记为 budget')
  ok(r.keptBytes <= 210, `剩下的总量 ${r.keptBytes} <= 210`)
  eq(r.kept.includes('2026-11-05.jsonl'), true, '预算再紧也不删今天')

  const both = planConversationPrune(all, { today: TODAY, keepDays: 4, maxBytes: 210 })
  const names = both.toDelete.map((x) => x.name)
  eq(new Set(names).size, names.length, '两个规则叠加时同一个文件不会被列两次')
}

// ---------------------------------------------------------------------------
console.log('\n④ 真实目录 · dryRun 与真删：')
{
  const dir = paths.diaryConversationsDir()
  const files = ['2026-01-01.jsonl', '2026-11-04.jsonl', '2026-01-02.jsonl.bak', 'keep.md']
  for (const f of files) writeFileSync(join(dir, f), `内容-${f}`, 'utf8')
  const config = { conversationRetentionDays: 3, conversationMaxTotalBytes: 0 }

  const dry = pruneConversations({ config, today: TODAY, dryRun: true })
  eq(dry.deleted, [], 'dryRun 不删任何文件')
  eq(dry.toDelete.map((x) => x.name), ['2026-01-01.jsonl'], 'dryRun 只是列出待删清单')
  ok(existsSync(join(dir, '2026-01-01.jsonl')), 'dryRun 之后旧文件仍在')

  const real = pruneConversations({ config, today: TODAY, dryRun: false })
  eq(real.deleted, ['2026-01-01.jsonl'], '真删只删了清单里的那一个')
  eq(existsSync(join(dir, '2026-01-01.jsonl')), false, '旧流水已删')
  for (const f of files.slice(1)) ok(existsSync(join(dir, f)), `其它文件未受影响：${f}`)
  eq(readFileSync(join(dir, '2026-11-04.jsonl'), 'utf8'), '内容-2026-11-04.jsonl', '保留的文件内容未被改写')

  const off = pruneConversations({ config: {}, today: TODAY, dryRun: false })
  eq([off.skipped, off.deleted.length], [true, 0], '默认配置下执行器直接跳过（不扫目录、不删）')
}

// ---------------------------------------------------------------------------
console.log('\n⑤ 配置与挂点：')
{
  const cfg = store.loadConfig()
  eq([cfg.conversationRetentionDays, cfg.conversationMaxTotalBytes], [0, 0], 'DEFAULT_CONFIG 两个新键默认都是 0')
  const normalized = memory.normalizeConfig({ conversationRetentionDays: 30, conversationMaxTotalBytes: 1048576 })
  eq([normalized.conversationRetentionDays, normalized.conversationMaxTotalBytes], [30, 1048576], 'normalizeConfig 透传新键（P0-3 修复未被绕过）')
  const keys = Object.keys(store.DEFAULT_CONFIG)
  ok(keys.includes('conversationRetentionDays') && keys.includes('conversationMaxTotalBytes'), '两个键都在 DEFAULT_CONFIG 白名单里（/config 可写）')

  // 端到端：collectForDiary 每轮会调 maybePruneConversations，但默认配置下一个都不该删。
  writeFileSync(join(paths.diaryConversationsDir(), '2026-01-03.jsonl'), '历史流水', 'utf8')
  try {
    diary.collectForDiary({ session: { header: { id: 'retention-test' } }, events: [] })
  } catch { /* 假 agent 缺宿主事件结构是预期内的，清理已在此前执行 */ }
  ok(existsSync(join(paths.diaryConversationsDir(), '2026-01-03.jsonl')), 'collectForDiary 在默认配置下没有删掉历史流水')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
rmSync(HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
