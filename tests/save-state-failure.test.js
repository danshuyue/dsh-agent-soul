/**
 * savePurposeState / saveMoodState 写失败回退回归（2026-11-05 DSH 复核收尾）
 *
 * 验收标准（树树原话）：「注入写失败后，再读 purposeState() 拿到的是新值不是旧的」，
 * 心情同款。S3 那轮只补了「结果不再被忽略 + 记日志」，清缓存仍无条件执行，
 * 属于同类 bug 只修了一半 —— 半修比不修危险，因为它看起来已经修过。
 *
 * 全程临时 DSH_HOME，故障注入走 paths.__setAtomicWriteFailureForTest()，
 * 不破坏任何已有文件。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-save-state-'))
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
paths.ensureDirs()

const INJECTED = '模拟磁盘满（测试注入）'
const failWrites = () => paths.__setAtomicWriteFailureForTest(() => ({ ok: false, error: INJECTED }))
const restoreWrites = () => paths.__setAtomicWriteFailureForTest(null)

// ---------------------------------------------------------------------------
console.log('\n① 目的状态：写失败不能回退')
{
  const { addGoal } = await import('../lib/purpose.js')
  // 注意：normalizeState 会把 drives clamp 到 0~1，拿它当新旧标记会被压成同一个值。
  // 用 goals 数组——唯一不会被归一化吃掉的可辨识字段。
  restoreWrites()
  const baseline = store.purposeState()
  addGoal(baseline, { text: '旧目标-甲' })
  eq(store.savePurposeState(baseline).ok, true, '准备：旧状态成功落盘')
  eq(store.purposeState().goals.length, 1, '准备：purposeState() 读到 1 条旧目标')

  failWrites()
  const next = store.purposeState()
  addGoal(next, { text: '新目标-乙' })
  const saved = store.savePurposeState(next)
  eq(saved.ok, false, '写盘失败返回 ok:false')
  ok(String(saved.error).includes(INJECTED), '失败原因带得回来')
  eq(store.purposeState().goals.length, 2, '★ 写失败后再读 purposeState() 拿到 2 条（不是回退成 1 条）')
  ok(store.purposeState().goals.some((g) => g.text.includes('新目标-乙')), '★ 新目标仍在内存里')
  eq(store.purposeState().goals.length, 2, '连读两次仍稳定（缓存没被反复清掉）')

  restoreWrites()
  const retried = store.savePurposeState(store.purposeState())
  eq(retried.ok, true, '恢复后可重试成功')
  eq(store.purposeState().goals.length, 2, '成功写盘后缓存失效，读盘仍是 2 条')
}

// ---------------------------------------------------------------------------
console.log('\n② 心情状态：写失败不能回退')
{
  const cwd = 'D:/proj/soul-test'
  restoreWrites()
  const baseline = store.resetMood(cwd)
  ok(baseline !== null && typeof baseline.mood === 'number',
    'resetMood 仍返回状态对象（旧契约未被写盘结果破坏）')
  const old = store.moodState(cwd)
  old.mood = 20
  eq(store.saveMoodState(cwd, old).ok, true, '准备：旧心情 20 成功落盘')
  eq(store.moodState(cwd).mood, 20, '准备：moodState() 读到旧值 20')

  failWrites()
  const next = store.moodState(cwd)
  next.mood = 88
  const saved = store.saveMoodState(cwd, next)
  eq(saved.ok, false, '写盘失败返回 ok:false')
  ok(String(saved.error).includes(INJECTED), '失败原因带得回来')
  eq(store.moodState(cwd).mood, 88, '★ 写失败后再读 moodState() 拿到新值 88（不是回退成 20）')

  // 另一个 cwd 的缓存不能被牵连
  const other = store.moodState('D:/proj/other')
  ok(other !== null && typeof other === 'object', '别的工作区的心情缓存未受影响')

  restoreWrites()
  eq(store.saveMoodState(cwd, store.moodState(cwd)).ok, true, '恢复后可重试成功')
  eq(store.moodState(cwd).mood, 88, '成功写盘后缓存失效，读盘仍是新值 88')
}

// ---------------------------------------------------------------------------
console.log('\n③ 对外链路：不能骗调用方')
{
  const { addGoal } = await import('../lib/purpose.js')
  const { registerApi, API_PREFIX } = await import('../lib/api.js')
  process.env.DSH_SOUL_API_TOKEN = 'soul-save-state-test-token-padded-to-32-'

  // 先在可写状态造一条能被关掉的目标，再进入故障态调 /goal。
  restoreWrites()
  const seed = store.purposeState()
  addGoal(seed, { text: '待关闭目标' })
  store.savePurposeState(seed)
  const goal = store.purposeState().goals.find((g) => g.text === '待关闭目标')
  ok(goal !== undefined, '准备：目标已在盘上')

  failWrites()
  let handler = null
  registerApi({ webServer: { register: (spec) => { handler = spec.handler; return () => {} } } })
  ok(typeof handler === 'function', 'API 路由注册成功')

  const fakeRes = () => {
    const out = { status: 0, body: '' }
    return { writeHead(code) { out.status = code }, end(chunk) { if (chunk != null) out.body += String(chunk) }, result: out }
  }
  const call = async (method, route, body) => {
    const res = fakeRes()
    const listeners = new Map()
    const req = {
      method, url: `${API_PREFIX}${route}`,
      headers: { host: '127.0.0.1:53397', 'x-soul-token': process.env.DSH_SOUL_API_TOKEN },
      socket: { remoteAddress: '127.0.0.1' },
      on(ev, cb) { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(cb); return req },
      destroy() {}
    }
    process.nextTick(() => {
      const fire = (ev, v) => (listeners.get(ev) ?? []).forEach((cb) => cb(v))
      if (body !== undefined) fire('data', Buffer.from(JSON.stringify(body), 'utf8'))
      fire('end')
    })
    await handler(req, res)
    return { status: res.result.status, body: res.result.body }
  }

  const closed = await call('POST', '/goal', { id: goal.id })
  eq(closed.status, 500, 'POST /goal 在写盘失败时回 500（不是 200「已放下」）')
  ok(closed.body.includes('"ok":false') || closed.body.includes('"ok": false'), '响应体明确 ok:false')
  const after = store.purposeState()
  const stillClosed = after.goals.find((g) => g.id === goal.id)?.closedAt
  ok(typeof stillClosed === 'string', '内存里目标已关闭且未回退（缓存保住了新状态）')

  restoreWrites()
  ok(store.purposeState() !== null, '恢复后目的状态仍可读')
}

restoreWrites()
console.log(`\n结果：${passed} 过 / ${failed} 败`)
rmSync(HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
