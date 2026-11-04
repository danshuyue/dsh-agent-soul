/**
 * tone.test.js —— 心情语气（2026-11-01）
 *
 * 三档 + 每 N 轮。守四件事：
 *   ① 中档永远不发（大多数轮次走这条）
 *   ② 低/高也要隔 N 轮，两条之间至少隔 N 轮
 *   ③ 中档要清计数器（从高档落到中档再升回高档，不该立刻补一条）
 *   ④ 关掉开关后一个字节都不发
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'soul-tone-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents'), { recursive: true })

const tone = await import('../lib/tone.js')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

const SID = 'session-tone-test'
const base = { moodBase: 70, moodToneThreshold: 8, moodToneInject: true, moodToneEveryTurns: 3 }

console.log('\n① 分档')
{
  const mk = (mood, dims = {}) => ({ mood, dims })
  eq(tone.toneLevelOf(mk(70), base), 'mid', '基准心情 → 中档')
  eq(tone.toneLevelOf(mk(65), base), 'mid', '只掉 5 → 中档')
  eq(tone.toneLevelOf(mk(62), base), 'low', '掉 8 就到线（>= 才算低档）')
  eq(tone.toneLevelOf(mk(63), base), 'mid', '掉 7 还在中档')
  eq(tone.toneLevelOf(mk(50), base), 'low', '掉 20 → 低档')
  eq(tone.toneLevelOf(mk(90), base), 'high', '涨 20 → 高档')
  eq(tone.toneLevelOf(mk(70, { sad: 15 }), base), 'low', '心情中段但难过爆表 → 低档')
  eq(tone.toneLevelOf(mk(70, { happy: 15 }), base), 'high', '心情中段但开心爆表 → 高档')
  eq(tone.toneLevelOf(null), 'mid', '没有状态 → 中档（不炸）')
  eq(tone.toneLevelOf(mk(70, { sad: 3 }), base), 'mid', '轻微情绪 → 中档')
}

console.log('\n② 三档文案')
{
  eq(tone.renderTone('mid'), '', '中档返回空串')
  ok(tone.renderTone('low').startsWith('［心情：'), '低档有前缀')
  ok(tone.renderTone('low').includes('不是这个人变了'), '带隔离说明')
  ok(!/\d/.test(tone.renderTone('high', 0).replace(/[^\d]/g, '')), '文案里没有数字')
  ok(tone.renderTone('low', 0) !== tone.renderTone('low', 1), '不同 seed 换说法')
}

console.log('\n③ 隔 N 轮（N=3）')
{
  tone.__resetToneForTest()
  const hits = []
  // 连着 7 轮都是低档
  for (let i = 0; i < 7; i += 1) {
    const r = tone.takeTone(SID, 'low', base)
    hits.push(r.emit ? 1 : 0)
  }
  eq(hits, [0, 0, 0, 1, 0, 0, 0], '第 4 轮发一次，之后每 3 轮一次')
}

console.log('\n④ 两条之间至少隔 N 轮（换档也不破坏）')
{
  tone.__resetToneForTest()
  const seq = ['low', 'low', 'low', 'high', 'high', 'high', 'high']
  const emitted = []
  for (const lv of seq) emitted.push(tone.takeTone(SID, lv, base).emit)
  // pending 从 0 数到 every=3 才发 → 第 4 次调用发（三次不发）
  // 发完归零，再数 3 次 → 第 8 次调用发。所以 7 轮只发 1 条。
  eq(emitted, [false, false, false, true, false, false, false], '换档不会缩短间隔')
  eq(tone.takeTone(SID, 'high', base).emit, true, '第 8 轮再发一条')
}

console.log('\n⑤ 中档清计数器')
{
  tone.__resetToneForTest()
  // 高档连数 2 轮（差 1 轮就发）
  tone.takeTone(SID, 'high', base)
  tone.takeTone(SID, 'high', base)
  // 中档一轮
  tone.takeTone(SID, 'mid', base)
  // 再回高档：应该重新数满 3 轮才发，而不是立刻补一条
  const a = tone.takeTone(SID, 'high', base).emit
  const b = tone.takeTone(SID, 'high', base).emit
  const c = tone.takeTone(SID, 'high', base).emit
  eq([a, b, c], [false, false, false], '中档把待发清零了')
  eq(tone.takeTone(SID, 'high', base).emit, true, '重新数满才发')
}

console.log('\n⑥ 关掉开关')
{
  tone.__resetToneForTest()
  let any = false
  for (let i = 0; i < 20; i += 1) {
    if (tone.takeTone(SID, 'low', { ...base, moodToneInject: false }).emit) any = true
  }
  eq(any, false, '关掉后 20 轮一条都不发')
}

console.log('\n⑦ 会话隔离 + 按「发了几条」算而不是「第几轮」')
{
  tone.__resetToneForTest()
  tone.takeTone('sA', 'low', base)
  const sB = tone.takeTone('sB', 'low', base)
  eq(sB.emit, false, '两个会话的计数器互不影响')

  tone.__resetToneForTest()
  const N = 5
  const cfg = { ...base, moodToneEveryTurns: N }
  const emits = []
  for (let i = 0; i < 12; i += 1) emits.push(tone.takeTone(SID, 'low', cfg).emit ? 1 : 0)
  const count = emits.reduce((a, b) => a + b, 0)
  ok(count <= Math.ceil(12 / N), `12 轮里最多 ${Math.ceil(12 / N)} 条（实际 ${count}）`)
}

console.log('\n⑧ 心情消息不会污染记忆提取')
{
  const extract = await import('../lib/extract.js')
  const toneEvent = {
    type: 'user/message',
    seq: 9,
    data: {
      content: [{ type: 'text', text: '［心情：今天心情不错，愿意多说两句。］' }],
      source: { kind: 'soul-tone' },
      role: 'user'
    }
  }
  eq(extract.isHumanEvent(toneEvent), false, 'soul-tone 来源不算人话')
  eq(extract.sourceKindOf(toneEvent), 'soul-tone', '来源能读出来')
  // 真人的照旧算
  const humanEvent = {
    type: 'user/message',
    seq: 10,
    data: { content: [{ type: 'text', text: '今天调了一下午 ADC' }], source: { kind: 'user' }, role: 'user' }
  }
  eq(extract.isHumanEvent(humanEvent), true, '真人消息不受影响')
}

console.log('\n节流下限与来源判定（2026-11-04 修 A1 自持循环 / 新②）：')
{
  // every 下限从 1 抬到 2：语气是往 next-step 投消息，claim 在下一个 step 才取走，
  // 那个 step 本身就是「多出来的一次请求」。every=1 会让每步都投 → 每步都催生下一步。
  // 计数器语义：pending 从 0 开始、每次 +1，累到 every 之后的下一次才发。
  // 也就是 every=2 → 第 1、2 次不发，第 3 次发。
  tone.__resetToneForTest()
  eq(tone.takeTone('s-every', 'low', { moodToneEveryTurns: 1 }).emit, false, 'every=1 被抬成 2：第 1 次不发')
  eq(tone.takeTone('s-every', 'low', { moodToneEveryTurns: 1 }).emit, false, '第 2 次仍不发')
  eq(tone.takeTone('s-every', 'low', { moodToneEveryTurns: 1 }).emit, true, '第 3 次才发（不再是每轮都投）')

  tone.__resetToneForTest()
  eq(tone.takeTone('s-2', 'low', { moodToneEveryTurns: 2 }).emit, false, '显式 every=2：第 1 次不发')
  eq(tone.takeTone('s-2', 'low', { moodToneEveryTurns: 2 }).emit, false, 'every=2：第 2 次不发')
  eq(tone.takeTone('s-2', 'low', { moodToneEveryTurns: 2 }).emit, true, 'every=2：第 3 次发')

  // soul-tone 必须算机器来源，否则下一轮判心情会拿自己的心情注解除判自己的心情
  const { isMachineSource } = await import('../lib/mood.js')
  eq(isMachineSource('soul-tone'), true, 'soul-tone 被判为机器来源（不参与心情判定）')
  eq(isMachineSource('user'), false, 'user 仍然是人的来源')
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
