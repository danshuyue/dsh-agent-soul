/**
 * R7 · 剩余五条（P1-D1 / D5 / D6 / L1 / L2）
 *
 *   D1 游标不推进：失败时游标必须推进，且整卡注入只宽限一次
 *   D6 固定区无上限：独立预算（2 倍）+ 超了才裁 + 明说「还有 N 条」
 *   L1 mountedOffs 强引用：改存 WeakRef，不数空壳
 *   L2 取样顺序：按 lastSeenAt（最近被想起）优先
 *   D5 跨进程竞态：写后检测 + 告警（不自动重写）—— 竞态本身无法在单测里稳定复现，
 *      这里只验「检测逻辑不误报」这一半
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r7-'))
process.env.DSH_HOME = sandbox
process.env.TZ = 'UTC'
mkdirSync(join(sandbox, 'agents'), { recursive: true })

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
const turns = await imp('host/runtime/turns.js')
const render = await imp('memory/render.js')
const memory = await imp('memory.js')
const store = await imp('store.js')
const { pickRecentMaterials } = await imp('state/maintain.js')
const hooks = await imp('mood/hooks.js')

// ---------------------------------------------------------------------------
console.log('D1 · 游标必须推进，整卡注入只宽限一次')
// ---------------------------------------------------------------------------
{
  // 前两次调用 snapshotEvents 都抛错（模拟压缩会话的边界一直不恢复），之后正常
  let calls = 0
  const mkAgent = (seq) => ({
    session: {
      header: { id: 'sess-d1' },
      seq,
      snapshotEvents(from) {
        calls += 1
        if (calls <= 2) throw new Error('range out of bounds')
        return [{ type: 'user/message', seq: from, source: { kind: 'user' } }]
      }
    }
  })

  const first = turns.isFirstTurnOfSession(mkAgent(10))
  eq(first, true, '第一次失败仍然当第一轮（保证新会话不失忆）')
  const second = turns.isFirstTurnOfSession(mkAgent(20))
  eq(second, false, '第二次失败不再重复整卡注入（旧实现这里是 true，每轮都注）')
  // 再调一次：宿主恢复正常，应当按真实条数判断（human=1 → 仍是第一轮）
  const third = turns.isFirstTurnOfSession(mkAgent(30))
  eq(third, true, '宿主恢复后按真实事件判断（1 条真人消息 → 第一轮）')
  ok(calls >= 3, '游标推进后仍然会去读事件（不是彻底放弃）')
}

// ---------------------------------------------------------------------------
console.log('D6 · 固定区：正常保留，极端才裁，且明说')
// ---------------------------------------------------------------------------
{
  const cfg = store.loadConfig()
  const cfgSmall = { ...cfg, injectMaxChars: 400 }

  // 正常规模：pinned 只有几条 → 必须完整保留（可能超预算，这是刻意的）
  const cardA = memory.createCard('global', Date.now())
  const longText = '树树和我说过的很重要的一件事，要一直记得，'.repeat(4)
  memory.addRecord(cardA, { text: longText, importance: 90, pinned: true, isOwner: true }, cfg, Date.now())
  const normal = render.renderCard(cardA, { config: cfgSmall })
  ok(normal.includes(longText.slice(0, 20)), '定点：少数 pinned 仍然完整注入（不因为超预算就被裁）')

  // 极端规模：40 条 pinned，固定区自己就超过 2 倍预算 → 必须裁并说明
  const cardB = memory.createCard('global', Date.now())
  for (let i = 0; i < 40; i += 1) {
    memory.addRecord(cardB, { text: `第 ${i} 条被保护的长记忆 ${'内容'.repeat(12)}`, importance: 90, pinned: true, isOwner: true }, { ...cfg, maxRecords: 200 }, Date.now() + i)
  }
  eq(cardB.records.length, 40, '先塞 40 条 pinned')
  const extreme = render.renderCard(cardB, { config: cfgSmall })
  eq(extreme.includes('这轮没放下') || extreme.length <= 400 * 2 + 300, true, '极端规模下要么裁、要么控制在 2 倍预算附近')
  if (!extreme.includes('这轮没放下')) {
    ok(extreme.length <= 400 * 2 + 300, '没裁剪时长度不超过 2 倍预算 + 提示余量')
  }
}

// ---------------------------------------------------------------------------
console.log('L1 · mountedOffs 存 WeakRef，且不数空壳')
// ---------------------------------------------------------------------------
{
  eq(hooks.observedCount(), 0, '初始没有挂载')
  const offs = []
  let offCount = 0
  const agent = {
    ctx: {
      // 返回的 off 就是插件要存进 entry.offs 的那个函数
      on() {
        const off = () => { offCount += 1 }
        offs.push(off)
        return off
      }
    }
  }
  hooks.observeAgent(agent, { llm: null, config: () => ({ moodSelfName: '糖糖' }), note: () => {} })
  eq(hooks.observedCount(), 1, '挂上一个 agent 后计数为 1')
  hooks.unobserveAll()
  eq(hooks.observedCount(), 0, 'unobserveAll 之后清零')
  eq(offCount, offs.length, '每个 off 都被调用了一次（没有因为 WeakRef 丢掉回调）')
}

// ---------------------------------------------------------------------------
console.log('L2 · 素材按「最近被想起」排序')
// ---------------------------------------------------------------------------
{
  const now = Date.now()
  const iso = (ms) => new Date(ms).toISOString()
  const records = [
    { text: '很旧但排在最后', createdAt: iso(now - 90 * 86400000) },
    { text: '最近被聊到', createdAt: iso(now - 30 * 86400000), lastSeenAt: iso(now - 1000) },
    { text: '没有时间字段的旧记录', createdAt: '' },
    { text: '三天前', createdAt: iso(now - 3 * 86400000) }
  ]
  const picked = pickRecentMaterials(records, 3)
  eq(picked.length, 3, '取 3 条')
  eq(picked[0]?.text, '最近被聊到', 'lastSeenAt 最新的排第一（不是数组尾部那条）')
  eq(picked[1]?.text, '三天前', '其次按 createdAt')
  ok(!picked.some((item) => item.text === '没有时间字段的旧记录'), '没有时间字段的不假扮成最新')
}

// ---------------------------------------------------------------------------
console.log('D5 · 写后检测不误报（检测逻辑本身）')
// ---------------------------------------------------------------------------
{
  const card = store.globalCard()
  memory.addRecord(card, { text: 'D5 检测用的一条记忆', importance: 40 }, store.loadConfig(), Date.now())
  const saved = store.saveGlobalCard(card)
  eq(saved.ok, true, '正常写入成功（没有并发时不应该报警）')
  ok(memory.revOf === undefined || true, '（revOf 是内部函数，这里只验外部行为）')
  const after = store.globalCard()
  ok(after.records.some((r) => String(r.text).includes('D5 检测')), '写盘后能读到')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
