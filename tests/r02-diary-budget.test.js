/**
 * R02 · T2 日记主流程总预算（第二份审查 H-2）
 *
 * 背景：`agents.resume` / `presets.resolve` / `presets.mount` 都没有超时，
 * 全链路唯一的超时是 composeDiaryText 里 llm-stream 的 30 秒，覆盖不到前段。
 * 一次挂起 = `startupInFlight` / `diaryInFlight` 永远不放 = 看门狗每轮直接 return
 * = 当天日记永久写不出来，日志里只有「开始写」没有下文。
 *
 * 这份测试用「永不 resolve 的 agents.resume」复现挂起，断言三件事：
 *   ① 调用方在预算内回来（不是永远挂着）
 *   ② 超时后立刻重入会被挡住（上一轮那条链还在跑，不能两个写手）
 *   ③ 默认预算是个正常人能接受的量级（不是 1ms 也不是 12 小时）
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r02-budget-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents', 'diary', 'conversations'), { recursive: true })

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

const { ensureDirs } = await imp('paths.js')
ensureDirs()
const { saveConfig } = await imp('store.js')
saveConfig({ diarySessionId: 'session-budget-test', diaryAgentWrite: true })

const scheduler = await imp('diary/scheduler.js')
const { runDiaryOnce, DIARY_TOTAL_BUDGET_MS, __resetDiaryInFlightForTest } = scheduler

const LOG = join(sandbox, 'agents', 'soul.log')
const readLog = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')

/** 永不 resolve 的 agents 服务：get 返回 undefined（走冷启动），resume 挂死 */
function hangingCtx() {
  const never = new Promise(() => {})
  return {
    get: (key) => {
      if (key === 'agents') {
        return {
          get: () => undefined,
          resume: () => never
        }
      }
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------
console.log('③ 默认预算的量级')
// ---------------------------------------------------------------------------
{
  ok(Number.isFinite(DIARY_TOTAL_BUDGET_MS), 'DIARY_TOTAL_BUDGET_MS 是有限数')
  ok(DIARY_TOTAL_BUDGET_MS >= 5 * 60_000, `默认预算 ${DIARY_TOTAL_BUDGET_MS}ms >= 5 分钟（不会把正常写日记卡死）`)
  ok(DIARY_TOTAL_BUDGET_MS <= 30 * 60_000, `默认预算 ${DIARY_TOTAL_BUDGET_MS}ms <= 30 分钟（不会等于没设）`)
}

// ---------------------------------------------------------------------------
console.log('① 挂起的链必须在预算内返回')
// ---------------------------------------------------------------------------
{
  const budget = 1000
  const started = Date.now()
  const result = await runDiaryOnce(hangingCtx(), '2026-11-05', undefined, { budgetMs: budget })
  const elapsed = Date.now() - started

  eq(result, false, '超时后返回 false（不是永远挂着）')
  ok(elapsed < budget + 900, `在预算内返回（实测 ${elapsed}ms，预算 ${budget}ms）`)
  ok(elapsed >= budget - 50, `确实等满了预算才放弃（不是提前失败，实测 ${elapsed}ms）`)
  ok(readLog().includes('超过总预算'), '日志里明确写了「超过总预算」（原来只有「开始写」没有下文）')
}

// ---------------------------------------------------------------------------
console.log('② 超时后立刻重入必须被挡住（不能两个写手）')
// ---------------------------------------------------------------------------
{
  const started = Date.now()
  const again = await runDiaryOnce(hangingCtx(), '2026-11-05', undefined, { budgetMs: 1000 })
  const elapsed = Date.now() - started
  eq(again, false, '重入被拒')
  ok(elapsed < 300, `立刻返回，没有再等一轮预算（实测 ${elapsed}ms）`)
  ok(readLog().includes('还没结束') || readLog().includes('不重入'), '日志说明了为什么拒绝（上一轮那条链还在跑）')
}

// ---------------------------------------------------------------------------
console.log('④ 清掉 in-flight 之后能重新开始（锁不是永久的）')
// ---------------------------------------------------------------------------
{
  __resetDiaryInFlightForTest()
  const started = Date.now()
  const third = await runDiaryOnce(hangingCtx(), '2026-11-05', undefined, { budgetMs: 1000 })
  const elapsed = Date.now() - started
  eq(third, false, '仍然失败（agents 依旧是挂的）')
  ok(elapsed >= 900, `但它真的重新跑了一轮（实测 ${elapsed}ms），说明锁被放开了`)
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
