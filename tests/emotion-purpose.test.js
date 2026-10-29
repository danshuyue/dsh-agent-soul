/**
 * 情绪 → 驱动 + 「说出去了才算完」测试：node tests/emotion-purpose.test.js
 *
 * 钉的是两块新接上的东西：
 *   1. 七情推动四个需求维度（担心 → 更惦记你，开心 → 更想分享）
 *   2. satisfyDrives 的闭环（这一段从写下来就没被接过，是死代码）
 *
 * 这两块一旦写错，表现是「她突然变得特别黏」或「驱动永远贴在基线上」——
 * 都不报错、只对体感有影响，所以要钉数值。
 */
import {
  BASE_DRIVES,
  applyEmotionToDrives,
  createState,
  dominantNeed,
  emotionTargets,
  markServed,
  normalizeState,
  openGoals,
  addGoal,
  settleServed,
  sharesPhrase
} from '../lib/purpose.js'

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
const near = (a, b, tolerance, name) => ok(Math.abs(a - b) <= tolerance, `${name}（实际 ${a}）`)

const HOUR = 3600000

console.log('\n[1] 情绪 → 目标驱动')

{
  const flat = emotionTargets({})
  ok(Math.abs(flat.care - BASE_DRIVES.care) < 1e-9, '没有情绪时目标就是基线')

  const worry = emotionTargets({ worry: 100 })
  ok(worry.care > BASE_DRIVES.care + 0.3, '担心拉满 → 明显更惦记你')
  ok(worry.care <= 1, '再担心也不会超过 1')

  const happy = emotionTargets({ happy: 100 })
  ok(happy.share > BASE_DRIVES.share + 0.3, '开心拉满 → 明显更想分享')

  const calm = emotionTargets({ calm: 100 })
  ok(calm.share < BASE_DRIVES.share, '踏实反而没那么急着说（满足感往下压）')

  // 三条都指向 care 的情绪同时拉满，不该把 care 顶到 1
  const stacked = emotionTargets({ heartache: 100, worry: 100, sad: 100 })
  ok(stacked.care <= 0.9 + 1e-9, '多条情绪不累加，只取最强的一条')
  ok(stacked.care > BASE_DRIVES.care, '但确实被推起来了')

  const partial = emotionTargets({ worry: 10 })
  near(partial.care, BASE_DRIVES.care + 0.45 * 0.9 * 0.5, 0.001, '情绪强度按比例折算')

  // 量纲标定：七情不是 100 分制 —— 判定单次上限 ±10、90 分钟半衰期衰减，
  // 实测一天走下来峰值只到 13。按 100 折算的话这层等于没接。
  const real = emotionTargets({ happy: 12 })
  ok(real.share > BASE_DRIVES.share + 0.1, '实测区间（峰值 12 上下）也推得动，不是空转')
  near(emotionTargets({ worry: 100 }).care, emotionTargets({ worry: 20 }).care, 1e-9,
    '超过 20 就当满格，不再往上加')
}

console.log('\n[2] 驱动向目标靠拢（不是累加）')

{
  let drives = { ...BASE_DRIVES }
  for (let i = 0; i < 40; i += 1) drives = applyEmotionToDrives(drives, { worry: 100 })
  ok(drives.care > 0.85, '持续担心 → care 收敛到高位')
  ok(drives.care <= 0.9 + 1e-9, '收敛有上限，不会被推到 1')

  // 情绪退了，驱动要跟着回落（累加式写法做不到这一点）
  let cooled = drives
  for (let i = 0; i < 60; i += 1) cooled = applyEmotionToDrives(cooled, { worry: 0 })
  near(cooled.care, BASE_DRIVES.care, 0.01, '情绪归零 → 驱动回到基线')

  const target = emotionTargets({ worry: 100 }).care
  const one = applyEmotionToDrives({ ...BASE_DRIVES }, { worry: 100 }, { pull: 0.15 })
  near(one.care, BASE_DRIVES.care + (target - BASE_DRIVES.care) * 0.15, 0.001, '一步只走 pull 那么多')

  const clamped = applyEmotionToDrives({ care: 0.99 }, { worry: 0 }, { pull: 1 })
  ok(clamped.care >= 0 && clamped.care <= 1, '坏输入（超出区间）也被夹回来')
}

console.log('\n[3] 有没有真的说出口')

{
  ok(sharesPhrase('记得帮我把衣服收了', '我帮你把衣服收进来啦'), '说到同一件事 → 命中')
  ok(sharesPhrase('答应过陪他去看展', '周末陪你去看展吧'), '语序不同也算命中')
  ok(!sharesPhrase('记得帮我把衣服收了', '今天天气不错'), '说的是别的事 → 不命中')
  ok(!sharesPhrase('记得帮我把衣服收了', ''), '她还没说话 → 不命中')
  ok(!sharesPhrase('记得帮我把衣服收了', '今天'), '两字通用词不算命中（3 字词组）')

  eq(dominantNeed('你别熬夜了好好休息'), 'care', '担心的话 → care')
  eq(dominantNeed('我发现一个好东西想给你看'), 'share', '想分享的话 → share')
}

console.log('\n[4] served 记录')

{
  const state = createState()
  addGoal(state, { text: '答应过帮树树把日记补上', kind: 'promise' })
  const goals = openGoals(state, { limit: 3 })

  ok(markServed(state, goals) === true, '第一次记下目标')
  eq(state.served.length, 1, 'served 里有一条')
  ok(markServed(state, goals) === false, '同一个目标不重复记')
  eq(state.served.length, 1, '还是一条')

  const restored = normalizeState({ ...state })
  eq(restored.served.length, 1, 'served 能存下来')
  eq(normalizeState({ served: [{ id: '' }, null, 'x', { id: 'a', text: 'y' }] }).served.length, 1,
    'served 里的坏条目被过滤')
}

console.log('\n[5] settleServed：说出口才真的降')

{
  const now = Date.now()
  const state = createState()
  state.drives = { ...BASE_DRIVES, care: 0.9 }
  state.served = [{ id: 'g1', text: '记得帮我把衣服收了', at: now - 3 * HOUR }]

  const before = state.drives.care
  const settled = settleServed(state, { assistantText: '我帮你把衣服收进来啦', now })
  eq(settled.sent, ['g1'], '说出口了 → sent')
  eq(state.served.length, 0, '判完就移出，不会反复降')
  near(state.drives.care, before * 0.45, 0.001, '说出口 → 驱动砍到 45%')

  // 再跑一次不该继续降（这条已经不在 served 里了）
  const again = settleServed(state, { assistantText: '我帮你把衣服收进来啦', now })
  eq(again.sent, [], '已经消化过的不重复判')
  near(state.drives.care, before * 0.45, 0.001, '驱动不再往下掉')
}

console.log('\n[6] settleServed：没说出口的两条路')

{
  const now = Date.now()

  // 刚渲染完（不到 1 分钟）：她还没机会说，什么都不做
  const fresh = createState()
  fresh.drives = { ...BASE_DRIVES, care: 0.9 }
  fresh.served = [{ id: 'g1', text: '记得帮我把衣服收了', at: now - 5000 }]
  const r1 = settleServed(fresh, { assistantText: '嗯嗯', now })
  eq(r1.sent, [], '刚渲染 → 不算没说')
  eq(r1.skipped, [], '刚渲染 → 也不算放弃')
  eq(fresh.served.length, 1, '留在列表里继续等')
  near(fresh.drives.care, 0.9, 0.001, '驱动不动')

  // 说了别的事，但还没到放弃的时候：继续等
  const waiting = createState()
  waiting.drives = { ...BASE_DRIVES, care: 0.9 }
  waiting.served = [{ id: 'g2', text: '答应过陪他去看展', at: now - 1 * HOUR }]
  const r2 = settleServed(waiting, { assistantText: '今天天气不错', now })
  eq(r2.sent, [], '没说到 → 不算 sent')
  eq(r2.skipped, [], '还早 → 不算放弃')
  eq(waiting.served.length, 1, '继续等着')
  near(waiting.drives.care, 0.9, 0.001, '驱动不动')

  // 等了 7 小时还没说：慢慢淡了
  const givenUp = createState()
  givenUp.drives = { ...BASE_DRIVES, care: 0.9 }
  givenUp.served = [{ id: 'g3', text: '答应过陪他去看展', at: now - 7 * HOUR }]
  const r3 = settleServed(givenUp, { assistantText: '今天天气不错', now })
  eq(r3.skipped, ['g3'], '超过 6 小时 → skipped')
  near(givenUp.drives.care, 0.9 * 0.85, 0.001, '没说出口只轻微回落（85%）')
}

console.log('\n[7] 闭环：惦记 → 说出口 → 驱动回落')

{
  const now = Date.now()
  const state = createState()
  addGoal(state, { text: '答应过提醒树树别熬夜', kind: 'promise' })
  const goals = openGoals(state, { limit: 3 })
  markServed(state, goals, now - 2 * HOUR)

  // 情绪先把它推起来：担心 → 更惦记
  state.drives = applyEmotionToDrives(state.drives, { worry: 80 })
  const pushed = state.drives.care
  ok(pushed > BASE_DRIVES.care, '担心把「惦记」推高了')

  // 她说出口了
  const settled = settleServed(state, { assistantText: '你今天别熬夜了，早点睡', now })
  eq(settled.sent.length, 1, '她说出口了')
  ok(state.drives.care < pushed, '驱动回落 —— 闭环成立')
  ok(state.drives.care >= BASE_DRIVES.care * 0.45 - 1e-9, '回落不是清零，还在基线附近')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
