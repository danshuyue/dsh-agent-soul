/**
 * 记忆提取测试：node tests/extract.test.js
 *
 * 这里守着 2026-10-29 那个真事故的回归：
 *   DSH 的 user/message 正文在 **data.content**，不在 data.message.content。
 *   写错一层，扫描照常跑、事件照常扫到，但候选永远是 0 —— 不报错、不落盘、
 *   记忆卡连文件都不生成。靠看日志是查不出来的，只能靠测试钉死。
 *
 * 所以下面的用例全部用**从真实会话文件里解压出来的事件结构**，
 * 不自己发明形状 —— 发明出来的结构只会让测试跟真机越走越远。
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

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'soul-extract-'))

const {
  collectCandidates,
  isPromotable,
  messageContentOf,
  isHumanEvent,
  sourceKindOf,
  textOfContent,
  worthRemembering
} = await import('../lib/extract.js')

/** 造一条和真机一模一样的 user/message。 */
const realEvent = (seq, text, kind) => ({
  type: 'user/message',
  seq,
  time: Date.now(),
  data: {
    content: [{ type: 'text', text }],
    source: { kind },
    role: 'user',
    id: `id-${seq}`
  },
  surfaceOp: 'append'
})

function makeAgent(events) {
  return {
    session: {
      header: { id: 'session-test' },
      get seq() {
        return events.length > 0 ? events[events.length - 1].seq : 0
      },
      firstLiveSeq: 0,
      snapshotEvents: (from, to) => events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
    }
  }
}

console.log('取正文（真机结构 data.content）：')

const sample = realEvent(1, '我打算明年参加蓝桥杯嵌入式赛道', 'user')
ok(messageContentOf(sample) !== undefined, 'data.content 取得到')
ok(textOfContent(messageContentOf(sample)) === '我打算明年参加蓝桥杯嵌入式赛道', '块数组还原成纯文本')
ok(sample?.data?.message === undefined, '真机事件里确实没有 data.message（这就是当年的坑）')

console.log('老格式与另一种宿主写法仍要认：')

const oldStyle = { type: 'user/message', seq: 2, data: { message: { content: [{ type: 'text', text: '老格式' }] } } }
ok(textOfContent(messageContentOf(oldStyle)) === '老格式', 'data.message.content 仍兼容')
const payloadStyle = { type: 'user/message', seq: 3, payload: { content: [{ type: 'text', text: 'payload 写法' }] } }
ok(textOfContent(messageContentOf(payloadStyle)) === 'payload 写法', 'payload 写法仍兼容')

console.log('来源过滤（机器注入的上下文一条都不许进记忆）：')

ok(isHumanEvent(realEvent(4, 'x', 'user')) === true, '真人说话 → 要')
ok(isHumanEvent(realEvent(5, 'x', 'qq')) === true, 'QQ 桥接进来的人话 → 要')
ok(isHumanEvent(realEvent(6, 'x', 'runtime-context')) === false, '运行时上下文 → 不要')
ok(isHumanEvent(realEvent(7, 'x', 'time-context')) === false, '时间上下文 → 不要')
ok(isHumanEvent(realEvent(8, 'x', 'skill-catalog')) === false, '技能清单 → 不要')
ok(isHumanEvent(realEvent(9, 'x', 'user-approval')) === false, '审批策略通知 → 不要')
ok(isHumanEvent(realEvent(10, 'x', 'compact-checkpoint')) === false, '压缩检查点 → 不要')
ok(isHumanEvent(realEvent(11, 'x', 'subagent')) === false, '子代理 → 不要')
ok(isHumanEvent(realEvent(12, 'x', 'schedule-xyz')) === false, '定时任务 → 不要')
ok(isHumanEvent(realEvent(13, 'x', '某种没见过的来源')) === false, '不认识的来源 → 保守不记')
ok(sourceKindOf(realEvent(14, 'x', 'user')) === 'user', '来源标记读得出来')

console.log('整条链路（真机事件跑一遍）：')

const events = [realEvent(1, '我打算明年参加蓝桥杯嵌入式赛道，现在手上有块F103开发板', 'user')]
const agent = makeAgent(events)
const first = collectCandidates(agent, { limit: 12 })
ok(first.candidates.length === 0, '第一次见这个会话只推游标，不回扫历史')

events.push(realEvent(2, '今天把戴维南定理学完了，明天接着学替代定理', 'user'))
events.push(realEvent(3, 'Current date: 2026-10-29; cwd: D:\\DSH workspace\\work', 'runtime-context'))
events.push(realEvent(4, '现在时间是下午四点二十分，星期四', 'time-context'))
events.push(realEvent(5, '可用技能：memory, mood, persona, purpose', 'skill-catalog'))

const second = collectCandidates(agent, { limit: 12 })
const texts = second.candidates.map((c) => c.text)
ok(texts.length === 2, `扫到 4 条只留 2 条真人的（实际 ${texts.length}）`)
ok(texts.some((t) => t.includes('戴维南')), '真人说的话进候选')
ok(texts.some((t) => t.includes('蓝桥杯')), '更早就说过的话也补进来了')
ok(!texts.some((t) => t.includes('Current date')), '运行时上下文被挡在外面')
ok(!texts.some((t) => t.includes('可用技能')), '技能清单被挡在外面')

console.log('打分：')

ok(worthRemembering('我打算明年参加蓝桥杯嵌入式赛道').ok === true, '有信息量的话过线')
ok(worthRemembering('嗯').ok === false, '太短的不记')
ok(worthRemembering('```js\nconsole.log(1)\n```').ok === false, '整段代码不记')

console.log('跨工作区双写判据（isPromotable）：')

const cand = (importance, tags) => ({ scored: { importance, tags } })
ok(isPromotable(cand(70, ['owner', 'self'])) === true, '关于本人 + 重要度够 → 进全局')
ok(isPromotable(cand(62, ['owner', 'self'])) === true, '刚好卡在门槛 62 → 进全局')
ok(isPromotable(cand(61, ['owner', 'self'])) === false, '差一分 → 不进')
ok(isPromotable(cand(90, ['owner'])) === false, '重要但跟本人无关 → 不进（不污染全局）')
ok(isPromotable(cand(90, [])) === false, '没标签 → 不进')
ok(isPromotable(cand(90, ['owner', 'self']), 80) === true, '门槛可调（传 80 时 90 仍过）')
ok(isPromotable(cand(70, ['owner', 'self']), 80) === false, '门槛可调（传 80 时 70 不过）')
ok(isPromotable(undefined) === false, '空候选不炸')
// 长期事实无条件进全局：换到任何工作区都该认得你，不该受分数门槛限制
ok(isPromotable(cand(30, ['owner', 'fact'])) === true, '长期事实（fact）分数再低也进全局')
ok(isPromotable(cand(50, ['owner', 'self'])) === false, '普通的「关于本人」没过门槛 → 不进')

console.log('值不值得记：流水账 vs 画像（2026-10-29 重调判据）：')

const score = (text) => worthRemembering(text, { isOwner: true })
// 原来「主人私下说的」直接 +42，而阈值就是 42 → 只要超过 8 个字就必定入库，
// 记忆卡里躺的全是「晚饭吃了什么」。现在这些要被拦掉。
ok(score('今天晚饭是牛肉丸子汤，现在正在吃饭').ok === false, '吃了什么 → 不记')
ok(score('多穿了点衣服，今天也不是很冷').ok === false, '穿了几件 → 不记')
ok(score('今天晚上在社团待到10点才往宿舍走').ok === false, '几点到哪 → 不记')
ok(score('我刚洗完澡，准备睡了').ok === false, '洗澡睡觉 → 不记')

// 有价值的要记得下，而且分数要明显拉开 —— 这才是「判据有区分度」
const identity = score('我是烟台大学机器人工程大二的学生')
const goal = score('我目标是当嵌入式工程师，偏软件方向')
const plan = score('我打算明年参加蓝桥杯嵌入式赛道')
const casual = score('我手上有一块 STM32F103 开发板')
ok(identity.ok === true, '身份事实 → 记')
ok(goal.ok === true, '长期目标 → 记')
ok(plan.ok === true, '计划打算 → 记')
ok(casual.ok === true, '普通陈述也记（判据不能矫枉过正，主人说的话仍然偏宽松）')
ok(identity.scored.importance >= 62, `画像分要拉开（实际 ${identity.scored.importance}）`)
ok(
  identity.scored.importance - casual.scored.importance >= 20,
  `画像比流水话高 20 分以上（${identity.scored.importance} vs ${casual.scored.importance}）`
)
ok(identity.scored.tags.includes('fact'), '身份事实带 fact 标签（永不遗忘 + 进全局）')

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
if (failed > 0) process.exit(1)
