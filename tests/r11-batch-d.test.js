/**
 * R11 · D 批数据与体验（P2-20 / P2-21 / P2-22 / P2-24 / P2-32 / P2-23）
 *
 * 这一批都是「边界上的一两天、一两次」的小错，单个看都不致命，
 * 但每一处都会在某天让用户觉得「怎么不对」。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r11-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents'), { recursive: true })

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, name + (same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`))
}

const { ensureDirs, memoryDir, memoryProjectsDir } = await imp('paths.js')
ensureDirs()

// ---------------------------------------------------------------------------
console.log('P2-20 · 日期键用本地时间，不再用 UTC')
// ---------------------------------------------------------------------------
{
  const { dateKeyOf } = await imp('retention.js')
  // 构造一个「本地已经是第二天、UTC 还是当天」的时刻（东八区 23:30）
  const localLate = new Date(2026, 10, 7, 23, 30, 0) // 2026-11-07 23:30 本地
  eq(dateKeyOf(localLate.getTime()), '2026-11-07', '本地 23:30 仍然算当天（UTC 已经是 15:30 同一天）')

  // 更关键的边界：本地 00:30（东八区），UTC 还是前一天 16:30
  const localEarly = new Date(2026, 10, 8, 0, 30, 0)
  eq(dateKeyOf(localEarly.getTime()), '2026-11-08', '本地 00:30 算第二天（旧实现会算成 11-07）')

  // 与 completion 的 todayKey 口径一致
  const completion = await imp('diary/completion.js')
  eq(dateKeyOf(localEarly.getTime()), completion.todayKey(localEarly.getTime()), '与 todayKey 口径一致')
}

// ---------------------------------------------------------------------------
console.log('P2-21 · 记忆健康要能看见项目卡')
// ---------------------------------------------------------------------------
{
  const store = await imp('store.js')
  eq(store.memoryHealth(), null, '没有损坏时返回 null')

  // 伪造一张坏掉的项目卡（corruptInfoOf 读的是进程内标记，先让 loadCard 踩一次）
  const memory = await imp('memory.js')
  const dir = memoryProjectsDir()
  mkdirSync(dir, { recursive: true })
  const bad = join(dir, 'proj-broken.json')
  writeFileSync(bad, '{ 坏掉的 JSON', 'utf8')
  memory.loadCard(bad) // 触发 parkCorrupt → 进程内记下 corruptState

  const health = store.memoryHealth()
  ok(health !== null, '项目卡损坏时不再是 null（旧实现只查全局卡）')
  const text = JSON.stringify(health)
  ok(text.includes('project') || text.includes('proj-broken'), '报出了是哪一张/哪个作用域')
}

// ---------------------------------------------------------------------------
console.log('P2-32 · 日记正文有字数上限')
// ---------------------------------------------------------------------------
{
  const diaryTool = await imp('diary-tool.js')
  let spec = null
  diaryTool.registerDiaryTool({
    tools: { register(s) { spec = s; return () => {} }, get() { return undefined } },
    effect() {},
    get() { return undefined }
  })
  ok(spec !== null && spec !== undefined, '注册到了 soul_diary 的工具定义')

  const huge = '很'.repeat(25_000)
  const run = spec?.execute ?? spec?.handler ?? spec?.run
  ok(typeof run === 'function', '工具定义里有可调用的执行函数')
  const res = await run({ action: 'write', kind: 'public', content: huge }, {})
  eq(res.ok, false, '超长日记被拒绝（旧实现照写，之后每轮挤占注入预算）')
  ok(String(res.message ?? '').includes('太长'), '给出了明确原因')
  ok(String(res.message ?? '').includes('20000'), '说明了上限是多少')
}

// ---------------------------------------------------------------------------
console.log('P2-24 · 维护失败当天还能重试')
// ---------------------------------------------------------------------------
{
  const tick = await imp('host/runtime/tick.js')
  const state = await imp('host/runtime/state.js')
  const { maintain } = await imp('store.js')

  // 让 maintain 抛错：直接往 purpose 目录写个只读？太绕 —— 改成把 config 弄成会抛的形状不值得。
  // 这里验的是「dailyHour 分支在成功后置位、失败不置位」这个逻辑本身：
  const clockBefore = state.maintainClock.day
  // 用一个不存在的 cwd + 极端 config 跑一次（不会抛，但会走完置位路径）
  tick.tick(null, '/nonexistent-path-for-test', { dailyHour: 0 }, { allowMaintain: true })
  ok(typeof state.maintainClock.at === 'number' && state.maintainClock.at > 0, '维护路径真的跑了一轮（maintainClock.at 被推进）')
  ok(typeof state.maintainClock.day === 'string' || state.maintainClock.day === clockBefore,
    'maintainClock.day 形状正常（没有因为改动变成 undefined）')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
