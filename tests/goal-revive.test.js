/**
 * 目标复活回归测试：node tests/goal-revive.test.js
 *
 * 守着 2026-10-29 体检发现的那个 bug：
 *
 *   maintain() 每 10 分钟从记忆卡里补一条目标，判据原来是
 *   `closedAt === null && item.text === goal.text` —— 只认「还开着的」。
 *   用户一旦点了「放下」，closeGoal 把 closedAt 设成时间字符串，
 *   exists 立刻变 false，下一轮 maintain 又从记忆里挖出一条全新的未闭合目标。
 *   表现：点「放下」，过十分钟它自己回来了，永远关不掉。
 *
 * 这个 bug 活了很久没被发现，因为 373 项测试里没有一项跑过 maintain()。
 * 所以这个文件专门盯着它，用真实流程走一遍：写记忆 → 挖目标 → 放下 → 再挖。
 */
import { mkdtempSync } from 'node:fs'
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

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'soul-goal-'))

const store = await import('../lib/store.js')
const purpose = await import('../lib/purpose.js')
const paths = await import('../lib/paths.js')

// 临时家目录里还没有 agents/memory，先建齐（真实运行时是 apply 早期建的）
paths.ensureDirs()

/** 一条明确带「明天」的承诺 —— purpose.js 的 PROMISE_RE 会把它挖成目标。 */
const PROMISE_TEXT = '明天把戴维南定理那三道题做完再睡'

console.log('前置：写一条承诺类记忆')
const written = store.writeMemory({
  cwd: '',
  scope: 'global',
  input: { text: PROMISE_TEXT, isOwner: true, isPrivate: true }
})
ok(written.ok === true, '记忆写入成功')

console.log('第一次 maintain：应该挖出目标')
store.maintain('', {})
let state = store.purposeState()
const firstGoal = state.goals.find((g) => g.text.includes('戴维南'))
ok(firstGoal !== undefined, '承诺被挖成一条目标')
ok(firstGoal !== undefined && firstGoal.closedAt === null, '新目标是开着状态')

console.log('用户点「放下」')
const closed = purpose.closeGoal(state, firstGoal === undefined ? '' : firstGoal.id)
store.savePurposeState(state)
state = store.purposeState()
const closedGoal = state.goals.find((g) => g.text.includes('戴维南'))
ok(closed === true, 'closeGoal 返回成功')
ok(closedGoal !== undefined && closedGoal.closedAt !== null, '目标标记为已闭合')

console.log('第二次 maintain：不许复活')
store.maintain('', {})
state = store.purposeState()
const openOnes = state.goals.filter((g) => g.text.includes('戴维南') && g.closedAt === null)
ok(openOnes.length === 0, '放下之后 maintain 不再把它挖回来')
ok(
  state.goals.filter((g) => g.text.includes('戴维南')).length === 1,
  '同名目标没有被复制成两条'
)

console.log('对照：没闭合的目标不会被重复添加')
store.maintain('', {})
store.maintain('', {})
state = store.purposeState()
ok(
  state.goals.filter((g) => g.text.includes('戴维南')).length === 1,
  '连续多次 maintain 也不会堆重复'
)

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
if (failed > 0) process.exit(1)
