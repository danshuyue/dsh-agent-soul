/**
 * 目的机制测试：node tests/purpose.test.js
 *
 * 这是「自主性」的内核，逻辑错了会表现成「她突然变得很黏或者完全没反应」——
 * 都属于难排查的那类。所以把衰减、目标挖掘、渲染长度都钉死。
 */
import {
  BASE_DRIVES,
  GOAL_KINDS,
  NEEDS,
  addGoal,
  closeGoal,
  createState,
  deriveDrives,
  mineGoals,
  moodOf,
  needAffinity,
  normalizeState,
  openGoals,
  renderPurpose,
  satisfyDrives,
  summarize
} from '../lib/purpose.js'
import { addRecord, createCard, normalizeConfig } from '../lib/memory.js'

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

const HOUR = 60 * 60 * 1000
const cfg = normalizeConfig({})

console.log('需求亲和：')
{
  const curious = needAffinity('这个为什么会卡住，好奇怪')
  ok(curious.curiosity > 0.4, `疑问句推高好奇（${curious.curiosity.toFixed(2)}）`)
  const care = needAffinity('你最近是不是太累了，注意休息')
  ok(care.care > 0.4, `关心推高在乎（${care.care.toFixed(2)}）`)
  const mastery = needAffinity('终于把这个搞定了，跑通了')
  ok(mastery.mastery > 0.4, `搞定推高掌握欲（${mastery.mastery.toFixed(2)}）`)
  const blank = needAffinity('嗯')
  ok(NEEDS.every((need) => blank[need] === 0), '没有信号时全 0（不硬凑）')
}

console.log('驱动衰减：')
{
  const now = Date.now()
  const high = { curiosity: 1, care: 1, share: 1, mastery: 1 }
  const eightHours = deriveDrives({ drives: high, drivesAt: now - 8 * HOUR, now })
  // 半衰期 8 小时：偏离基线的一半
  const expected = BASE_DRIVES.curiosity + (1 - BASE_DRIVES.curiosity) * 0.5
  ok(Math.abs(eightHours.drives.curiosity - expected) < 0.02, `8 小时后落一半（${eightHours.drives.curiosity.toFixed(3)} ≈ ${expected.toFixed(3)}）`)

  const long = deriveDrives({ drives: high, drivesAt: now - 72 * HOUR, now })
  ok(long.drives.curiosity < BASE_DRIVES.curiosity + 0.03, '三天后基本回到基线')

  const fresh = deriveDrives({ drives: high, drivesAt: now, now })
  ok(fresh.drives.curiosity > 0.95, '刚算过时几乎是原值')

  // 久没说话 → 想分享会上涨
  const idle = deriveDrives({ drives: { ...BASE_DRIVES }, drivesAt: now, now, idleHours: 24 })
  ok(idle.drives.share > BASE_DRIVES.share, `久没说话会想分享（${idle.drives.share.toFixed(3)} > ${BASE_DRIVES.share}）`)

  // 素材刺激
  const withMaterial = deriveDrives({
    drives: { ...BASE_DRIVES },
    drivesAt: now,
    now,
    materials: [{ text: '这个为什么不行？好奇怪' }, { text: '为什么又报错' }]
  })
  ok(withMaterial.drives.curiosity > BASE_DRIVES.curiosity, '聊到疑问会推高好奇')
}

console.log('状态推导：')
{
  eq(moodOf({ curiosity: 0.2, care: 0.2, share: 0.2, mastery: 0.2 }).mood, 'calm', '都低时是安静')
  eq(moodOf({ curiosity: 0.9, care: 0.2, share: 0.2, mastery: 0.2 }).mood, 'curious', '好奇最高 → curious')
  eq(moodOf({ curiosity: 0.2, care: 0.9, share: 0.2, mastery: 0.2 }).mood, 'attentive', '在乎最高 → attentive')
  eq(moodOf({ curiosity: 0.2, care: 0.2, share: 0.9, mastery: 0.2 }).mood, 'chatty', '想分享最高 → chatty')
  ok(moodOf(BASE_DRIVES).label.length > 0, '有中文标签')
}

console.log('满足驱动：')
{
  const after = satisfyDrives({ curiosity: 0.9, care: 0.5, share: 0.5, mastery: 0.5 }, 'curiosity', 'sent')
  ok(after.curiosity < 0.5, `说出去了驱动明显回落（${after.curiosity.toFixed(2)}）`)
  const skipped = satisfyDrives({ curiosity: 0.9, care: 0.5, share: 0.5, mastery: 0.5 }, 'curiosity', 'skipped')
  ok(skipped.curiosity > 0.7, '没说出去只轻微回落')
  const unknown = satisfyDrives({ curiosity: 0.9 }, '不存在的维度', 'sent')
  ok(typeof unknown.curiosity === 'number', '未知维度不炸')
}

console.log('从记忆挖目标：')
{
  const now = Date.now()
  const card = createCard('global')
  addRecord(card, { text: '树树说下次一起把补历史功能补完，别忘了', isOwner: true, isPrivate: true, source: 'test' }, cfg, now)
  addRecord(card, { text: 'USART 那个中断为什么一进 DMA 就卡住，还没搞清楚', isOwner: true, isPrivate: true, source: 'test' }, cfg, now)
  addRecord(card, { text: '有点好奇 Rust 写嵌入式到底靠不靠谱', isOwner: true, isPrivate: true, source: 'test' }, cfg, now)
  addRecord(card, { text: '今天天气不错，去操场跑了三公里', source: 'test' }, cfg, now)

  const goals = mineGoals(card)
  ok(goals.length === 3, `挖到 3 个目标（实际 ${goals.length}）`)
  ok(goals.some((goal) => goal.kind === 'promise'), '答应的事被识别为 promise')
  ok(goals.some((goal) => goal.kind === 'question'), '疑问被识别为 question')
  ok(goals.some((goal) => goal.kind === 'curious'), '好奇被识别为 curious')
  ok(!goals.some((goal) => goal.text.includes('天气')), '普通闲聊不出目标')
  eq(goals[0].kind, 'promise', 'promise 权重最高排第一')

  // 已遗忘的不算
  const card2 = createCard('global')
  const r = addRecord(card2, { text: '答应过的一件事，但已经忘得差不多了', source: 'test' }, cfg, now)
  r.record.clarity = 'forgotten'
  eq(mineGoals(card2).length, 0, '已遗忘的记忆不产生目标')
}

console.log('目标增删：')
{
  const state = createState()
  const a = addGoal(state, { text: '把 STM32 的中断优先级搞明白', kind: 'question' })
  ok(a.ok === true, '加上了')
  const dup = addGoal(state, { text: '把 STM32 的中断优先级搞明白' })
  eq(dup.ok, false, '同样的话不重复加')
  ok(dup.reason.includes('已经在惦记'), '说明原因')

  const blank = addGoal(state, { text: '   ' })
  eq(blank.ok, false, '空目标被拒')

  addGoal(state, { text: '想试试用 Rust 写个小工具', kind: 'curious' })
  eq(openGoals(state).length, 2, '两个待办')

  const closed = closeGoal(state, a.goal.id)
  eq(closed, true, '关掉成功')
  eq(openGoals(state).length, 1, '待办少了一个')
  eq(closeGoal(state, '不存在的 id'), false, '关不存在的返回 false')

  // 上限 40
  const big = createState()
  for (let i = 0; i < 60; i += 1) addGoal(big, { text: `目标编号 ${i}` })
  ok(big.goals.length <= 40, `目标有上限（${big.goals.length} ≤ 40）`)
}

console.log('渲染：')
{
  const state = createState()
  const blank = renderPurpose(state)
  eq(blank, '', '没有目标且状态安静时不塞空块')

  addGoal(state, { text: '把补历史功能补完', kind: 'promise', weight: 80 })
  addGoal(state, { text: '搞明白 USART 为什么卡住', kind: 'question', weight: 70 })
  addGoal(state, { text: '试试 Rust 写嵌入式', kind: 'curious', weight: 50 })
  addGoal(state, { text: '第四条不该出现', kind: 'curious', weight: 10 })

  const out = renderPurpose(state)
  ok(out.includes('【你心里惦记的事】'), '有标题')
  ok(out.includes('答应过的'), '标出了目标类型')
  ok(out.includes('补历史功能补完'), '内容在')
  ok(!out.includes('第四条不该出现'), '只渲染前 3 条（控制每轮成本）')
  ok(out.length <= 320, `长度可控（${out.length} 字）`)
  ok(out.includes('不需要每轮都提'), '明确告诉模型别每轮都提（防复读）')

  state.drives = { curiosity: 0.9, care: 0.2, share: 0.2, mastery: 0.2 }
  ok(renderPurpose(state).includes('此刻状态'), '驱动高时带一句状态')

  const long = createState()
  for (let i = 0; i < 6; i += 1) addGoal(long, { text: `很长的目标描述第 ${i} 条，用来测试长度上限是否真的生效`, kind: 'curious' })
  ok(renderPurpose(long, { maxChars: 120 }).length <= 121, '极短预算下也会截断')
}

console.log('结构收敛：')
{
  const broken = normalizeState({ drives: { curiosity: 'abc' }, goals: [{ text: '' }, null, { text: '有效目标' }] })
  ok(Number.isFinite(broken.drives.curiosity), '坏驱动值回落到基线')
  eq(broken.goals.length, 1, '坏目标被过滤')
  ok(GOAL_KINDS[broken.goals[0].kind] !== undefined, 'kind 是合法值')

  const empty = normalizeState(null)
  eq(empty.goals, [], 'null 也能收敛成空状态')
  ok(NEEDS.every((need) => Number.isFinite(empty.drives[need])), '驱动字段齐全')

  const sum = summarize(empty)
  ok(typeof sum.mood.label === 'string', '摘要带状态标签')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
