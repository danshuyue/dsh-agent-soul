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
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'soul-extract-'))

const {
  autoMemoryRejectReason,
  collectCandidates,
  ingestCandidates,
  isEchoOfAssistant,
  isPromotable,
  isSubagentSession,
  messageContentOf,
  minImportanceForKind,
  isHumanEvent,
  sourceKindOf,
  textOfContent,
  unwrapBridgeText,
  worthRemembering
} = await import('../lib/extract.js')
const { addRecord, createCard, normalizeConfig } = await import('../lib/memory.js')
const { writeAutoMemories } = await import('../lib/store.js')
const { ensureDirs } = await import('../lib/paths.js')

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

console.log('')
console.log('子会话识别（2026-10-30：source.kind 过滤挡不住「当前 agent 本身是子会话」）：')

ok(isSubagentSession({ session: { header: { origin: 'subagent' } } }) === true, 'header.origin=subagent → 子会话')
ok(isSubagentSession({ session: { header: {} } }) === false, '没有 origin → 不是子会话')
ok(isSubagentSession({ session: { header: { id: 'x', cwd: 'D:\\' } } }) === false, '普通会话（有 id/cwd）→ 不是')
ok(isSubagentSession(undefined) === false, '空 agent 不炸')

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

// ---------------------------------------------------------------------------
// 桥接信封与回显（2026-10-30：这三条垃圾记忆逼出来的）
// ---------------------------------------------------------------------------
console.log('')
console.log('桥接信封：剥掉说明、丢掉触发模板')

const envelope = unwrapBridgeText('（QQ 私聊·用户本人 QQ 3472302240）起了起了')
ok(envelope.text === '起了起了', '剥掉「（QQ 私聊·用户本人…）」只留正文')
ok(envelope.drop === false, '真人说的话不丢')

const trigger = unwrapBridgeText('（主动搭话：距上次说话已经 6 小时 3 分钟。想说什么就说…就 qq_pass，不用硬找话。）')
ok(trigger.drop === true, '主动搭话的模板整条丢掉')

const bare = unwrapBridgeText('主动搭话：距上次说话已经 0 分钟')
ok(bare.drop === true, '没有信封也要认得出来是模板')

const casualBox = unwrapBridgeText('（笑）今天好累啊')
ok(casualBox.text === '今天好累啊', '无害的括号说明照剥（正文留着）')

ok(unwrapBridgeText('我今天很累，想早点睡').text === '我今天很累，想早点睡', '没有信封就原样返回')
ok(unwrapBridgeText('').drop === true, '空文本丢掉')

console.log('')
console.log('回显：她自己的话被桥投回来时不能当记忆')

const herLine = '唔…早上好喵~'
ok(isEchoOfAssistant(herLine, [herLine]) === true, '一模一样 → 是回显')
ok(isEchoOfAssistant('唔…早上好喵', [herLine]) === true, '只差标点也算回显')
ok(isEchoOfAssistant('我帮你把衣服收进来啦', ['（动作）我帮你把衣服收进来啦（语音）']) === true, '包含关系也算')
ok(isEchoOfAssistant('起了起了', [herLine]) === false, '不一样 → 不是回显')
ok(isEchoOfAssistant('嗯', ['嗯']) === false, '太短的骨架不判回显（宁可留着）')

console.log('')
console.log('端到端：一轮里同时出现真话、回显、模板、路径')

const mixed = [
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '（主动搭话：距上次说话已经 6 小时。qq_pass）' }], source: { kind: 'user' }, role: 'user' } },
  { type: 'assistant/message', seq: 2, data: { content: [{ type: 'text', text: '唔…早上好喵~' }], role: 'assistant' } },
  { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '（QQ 私聊·用户本人 QQ 3472302240）唔…早上好喵~' }], source: { kind: 'user' }, role: 'user' } },
  { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: '（QQ 私聊·用户本人 QQ 3472302240）起了起了' }], source: { kind: 'user' }, role: 'user' } },
  { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: '我今早七点多才起来，昨晚在忙着给你做插件' }], source: { kind: 'user' }, role: 'user' } },
  { type: 'user/message', seq: 6, data: { content: [{ type: 'text', text: '@C:////Users////Administrator////.dsh////plugins////dsh' }], source: { kind: 'user' }, role: 'user' } },
  { type: 'user/message', seq: 7, data: { content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapsh' }], source: { kind: 'runtime-context' }, role: 'user' } }
]
// 第一次见会话时游标被推到「当前 seq」，所以要先让它从 0 开始，再"长出"新事件
let mixedSeq = 0
const mixedAgent = {
  session: {
    header: { id: 'session-mixed' },
    get seq() { return mixedSeq },
    firstLiveSeq: 0,
    snapshotEvents: (from, to) => mixed.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
  }
}
collectCandidates(mixedAgent, { limit: 12 })   // 第一次只初始化游标（此刻 seq=0）
mixedSeq = 7
const round = collectCandidates(mixedAgent, { limit: 12 })

ok(round.candidates.length === 1, `七条里只剩一条真话（实际 ${round.candidates.length} 条）`)
ok(round.candidates[0]?.text === '我今早七点多才起来，昨晚在忙着给你做插件', '留下的正是真人说的那句')
ok(round.candidates[0]?.text.includes('（QQ') === false, '记忆正文里不再带桥接前缀')

console.log('')
console.log('路径不该当记忆')
ok(worthRemembering('@C:////Users////Administrator////.dsh////plugins////dsh').ok === false, '拖进来的 Windows 路径被挡')
ok(worthRemembering('/home/user/.dsh/agents/memory').ok === false, 'Unix 路径也被挡')

console.log('')
console.log('落库硬过滤（2026-10-30：提示词管不住的用规则兜底）')

// 四个拒收样例全部照抄用户当场抓到的那三条垃圾记忆 + 一条任务进度
const junkSamples = [
  ['帮我修改一下 C:\\Users\\Administrator\\.dsh\\plugins\\dsh-onebot-channel 插件，让每一次发给AI的信息带时间', '祈使句'],
  ['对当前桥接代码进行最后一次检测。确认整体无误后，进行git记录并推到github。', '「对…进行…」/代码改动'],
  ['树树最近在排查 pwsh 每次调用都在初始化阶段失败的问题，牵连 sandbox 设置', '工作状态'],
  ['树树今天把开发板焊好了，下一步要写串口程序', '时间锚点/下一步']
]
for (const [text, why] of junkSamples) {
  const reason = autoMemoryRejectReason(text)
  ok(reason !== null, `${why} → 拒收（${String(reason)}）`)
}

// 该记的不能被误杀：稳定的身份 / 偏好 / 习惯
for (const text of [
  '树树是烟台大学机器人工程专业大二学生',
  '树树不敢吃辣，一点辣都受不了',
  '树树晚上 11 点会上线跑图',
  '答应过树树，以后提醒他别熬夜'
]) {
  ok(autoMemoryRejectReason(text) === null, `不是任务 → 放行（${text.slice(0, 12)}…）`)
}

// 代码 + 动作，但整条在说人 → 放行（人比任务值钱）
ok(
  autoMemoryRejectReason('树树喜欢把插件代码写完才提交，习惯一次改完') === null,
  '代码+动作但带人物属性 → 不按任务丢'
)

console.log('')
console.log('按 kind 分档的重要度门槛（默认值只在 DEFAULTS 里定义一次）')

const autoCfg = normalizeConfig({})
eq(autoCfg.autoImportanceEvent, 70, 'event 的门槛是 70')
eq(autoCfg.autoImportanceDefault, 42, 'fact/preference/promise 仍是 42')
eq(minImportanceForKind('event', autoCfg), 70, 'minImportanceForKind(event) → 70')
eq(minImportanceForKind('fact', autoCfg), 42, 'minImportanceForKind(fact) → 42')
eq(minImportanceForKind(undefined, autoCfg), 70, '没有 kind 的自动候选按 event 卡（老路径更严）')
eq(normalizeConfig({ autoImportanceEvent: 999 }).autoImportanceEvent, 100, '配置写过头就夹回 100，不静默失效')

console.log('')
console.log('ingestCandidates（原话直存路径）也要过闸')

{
  const card = createCard('project')
  const written = ingestCandidates(card, addRecord, [
    { text: '帮我把这个插件改一下，让消息带上时间', isOwner: true, scored: { importance: 88, tags: ['owner'] } },
    { text: '树树喜欢喝冰美式，一天两杯', isOwner: true, scored: { importance: 80, tags: ['owner'] } },
    { text: '树树随手记了一条普通的事，够长但不重要', isOwner: true, scored: { importance: 45, tags: ['owner'] } }
  ], {}, Date.now())
  eq(written, 1, '三条只留一条（任务被拒 + 低分 event 被拒）')
  eq(card.records.length, 1, '卡里只进了一条')
  ok(card.records[0].text.includes('冰美式'), '留下的是偏好那条')
}

console.log('')
console.log('writeAutoMemories（提炼落库路径）端到端')

{
  // 用 DSH_HOME 临时目录（本文件开头已设），避免碰真卡
  ensureDirs()
  const report = writeAutoMemories('D:\\soul-test-proj', [
    { text: '帮我修改一下 onebot 插件，让每次发给AI的信息带时间', importance: 80, kind: 'event' },
    { text: '对当前桥接代码进行最后一次检测，然后提交推送', importance: 80, kind: 'event' },
    { text: '树树最近在排查 pwsh 初始化失败的问题', importance: 80, kind: 'event' },
    { text: '树树今天把开发板焊好了', importance: 80, kind: 'event' },
    { text: '树树把开发板焊好了', importance: 60, kind: 'event' },
    { text: '树树喜欢喝冰美式，一天两杯', importance: 70, kind: 'preference' },
    { text: '树树是烟台大学机器人工程专业大二学生', importance: 85, kind: 'fact' }
  ], {})
  eq(report.written, 2, '七条只写两条（四类任务 + 一条低分 event 全被拒）')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
if (failed > 0) process.exit(1)
