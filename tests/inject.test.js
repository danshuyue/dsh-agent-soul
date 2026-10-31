/**
 * 注入改造测试（P1，2026-10-30）：node tests/inject.test.js
 *
 * 守四件事：
 *   ① 配置：memoryRecall 默认开、topK 默认 3（2026-10-30：6 → 3）、注入预算默认 3200，且默认值只有一处；
 *   ② 中文 bigram 召回：整句切词召回不到的「蓝桥杯嵌入式」，改完能召回；
 *   ③ 排序：清晰度低但命中的琐事，不能翻到持久事实前面；
 *   ④ 开关等价性：memoryRecall:false 的输出与旧路径（renderMemoryBlock）逐字节一致，
 *      且旧模式在内容上是新模式（固定区 + 相关区）的超集。
 *
 * 数据全部落在临时 DSH_HOME，不碰真实的 ~/.dsh。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

const sandbox = mkdtempSync(join(tmpdir(), 'soul-inject-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents', 'memory', 'projects'), { recursive: true })

const memory = await import('../lib/memory.js')
const store = await import('../lib/store.js')
const extract = await import('../lib/extract.js')

const { DEFAULTS, addRecord, createCard, normalizeConfig, recall, renderCard, setPinned } = memory
const now = Date.now()

/** 造一张卡：records 直接给入参，方便控制 clarity / kind / pinned。 */
function cardOf(scope, specs) {
  const card = createCard(scope)
  for (const spec of specs) {
    const result = addRecord(card, { text: spec.text, source: 'test', ...spec }, normalizeConfig({}), spec.createdAt ?? now)
    if (spec.clarity !== undefined) result.record.clarity = spec.clarity
    if (spec.pinned === true) setPinned(card, result.record.id, true)
    if (spec.isInitial === true) result.record.isInitial = true
  }
  return card
}

console.log('配置默认值（2026-10-30）：')
{
  const cfg = normalizeConfig({})
  eq(cfg.memoryRecall, true, 'memoryRecall 默认开')
  eq(cfg.memoryRecallTopK, 3, 'memoryRecallTopK 默认 3（2026-10-30：6 → 3）')
  eq(cfg.injectMaxChars, 3200, '注入预算默认 3200')
  eq(normalizeConfig({ memoryRecall: false }).memoryRecall, false, 'memoryRecall 能关')
  eq(normalizeConfig({ memoryRecall: 'yes' }).memoryRecall, false, '非 true 的布尔值一律归 false（不吃字符串）')
  eq(normalizeConfig({ memoryRecallTopK: 0 }).memoryRecallTopK, 1, 'topK 下限 1')
  eq(normalizeConfig({ memoryRecallTopK: 999 }).memoryRecallTopK, 50, 'topK 上限 50')
  eq(store.DEFAULT_CONFIG.injectMaxChars, DEFAULTS.injectMaxChars, '预算默认值只有一处（store 引用 memory.DEFAULTS）')
}

console.log('中文 bigram 召回（2026-10-30）：')
{
  const card = cardOf('global', [
    { text: '树树想明年打蓝桥杯嵌入式赛道试试', importance: 70, kind: 'preference' },
    { text: '树树的电脑是 ThinkPad，装的是 VS Code', importance: 55, kind: 'fact' },
    { text: '今天晚饭是牛肉丸子汤', importance: 20, kind: 'event' }
  ])
  eq(recall(card, '蓝桥杯嵌入式').length, 1, '整句不在原文里，bigram 也能召回（蓝桥/桥杯/杯嵌/嵌入/入式）')
  eq(recall(card, '蓝桥杯嵌入式')[0].record.text.includes('蓝桥杯'), true, '召回的正是那条')
  eq(recall(card, 'ThinkPad').length, 1, '拉丁词照旧按空白切、长度≥2 才留')
  eq(recall(card, 'ThinkPad')[0].record.text.includes('ThinkPad'), true, '拉丁词命中的是那条')
  eq(recall(card, '完全不存在的关键词组合').length, 0, '搜不到就是搜不到')
  eq(recall(card, '').length, 0, '空查询返回空')

  // 单条 bigram 计分封顶：长文本不能靠碎片多刷分
  const longQuery = '蓝桥杯嵌入式赛道备赛计划有点紧张'
  const long = cardOf('global', [{ text: longQuery, importance: 0, kind: 'event', clarity: 'vivid' }])
  const longHit = recall(long, longQuery)[0]
  ok(longHit.gramHits > 10, `长查询的 bigram 命中数超过 10（${longHit.gramHits}）`)
  // 整段命中 30 + 封顶后的 10 个 bigram 30 + vivid 10 = 70；
  // 没封顶的话是 30 + 13*3 + 10 = 79
  eq(longHit.score, 70, '计分只算前 10 个 bigram（没有随碎片数线性膨胀）')
}

console.log('相关区排序：持久事实不能被命中琐事挤下去（2026-10-30）：')
{
  const card = cardOf('global', [
    { text: '树树的目标是嵌入式工程师，蓝桥杯要打嵌入式赛道', importance: 62, kind: 'fact', clarity: 'fuzzy' },
    { text: '昨天聊到蓝桥杯的时候他有点紧张', importance: 20, kind: 'event', clarity: 'vivid' }
  ])
  const ranked = recall(card, '蓝桥杯嵌入式')
  eq(ranked.length, 2, '两条都命中')
  eq(ranked[0].record.kind, 'fact', 'fact 排前面（clear 低也不让位给命中多的事件）')

  // 固定过的记忆命中时优先
  const pinnedCard = cardOf('global', [
    { text: '答应过树树一起把记忆注入改完', importance: 30, kind: 'promise', clarity: 'fuzzy', pinned: true },
    { text: '随口说过记忆注入的事', importance: 80, kind: 'event', clarity: 'vivid' }
  ])
  eq(recall(pinnedCard, '记忆注入')[0].record.pinned, true, 'pinned 命中时排最前')
}

console.log('注入两段 + 开关等价性（2026-10-30）：')
{
  const cwd = join(sandbox, 'proj-inject')
  const project = cardOf('project', [
    { text: '这个仓库用 pnpm，别用 npm 装依赖', importance: 75, kind: 'fact' },
    { text: '树树说蓝桥杯要报嵌入式赛道', importance: 66, kind: 'promise' }
  ])
  const global = cardOf('global', [
    { text: '树树的目标是嵌入式工程师', importance: 80, kind: 'fact', isInitial: true },
    { text: '树树喜欢喝冰美式，不加糖', importance: 60, kind: 'preference', pinned: true },
    { text: '上周聊过蓝桥杯的备赛计划，挺紧张的', importance: 30, kind: 'event' }
  ])
  store.saveProjectCard(cwd, project)
  store.saveGlobalCard(global)

  const offCfg = normalizeConfig({ memoryRecall: false })
  const legacy = store.renderMemoryBlock(cwd, offCfg)
  const recalledOff = store.renderMemoryBlockRecalled(cwd, offCfg, '蓝桥杯要报什么赛道')
  eq(recalledOff, legacy, 'memoryRecall:false 与旧路径逐字节一致')

  const onCfg = normalizeConfig({ memoryRecall: true })
  const recalledOn = store.renderMemoryBlockRecalled(cwd, onCfg, '蓝桥杯要报什么赛道')
  ok(recalledOn.includes('## 和这句话有关的'), '开启后有相关区')
  ok(recalledOn.includes('蓝桥杯'), '相关区召回了跟这句话有关的那条')
  ok(recalledOn.includes('## 我们的开始'), '固定区照旧（我们的开始）')
  ok(recalledOn.includes('## 永远不会忘的'), '固定区照旧（永远不会忘的）')

  // 内容层面的超集：新模式里出现的每条记录原文，旧模式里都有（类型标记是新增前缀）
  const texts = [...project.records, ...global.records].map((r) => r.text)
  const missing = texts.filter((text) => recalledOn.includes(text) && !legacy.includes(text))
  eq(missing, [], '旧模式是完整超集（新模式展示的每条原文旧模式都有）')

  // 项目卡和全局卡一起打分、按 text 去重：同一句话只出现一次
  const dupCwd = join(sandbox, 'proj-dup')
  const dupText = '树树想打蓝桥杯嵌入式赛道'
  store.saveProjectCard(dupCwd, cardOf('project', [{ text: dupText, importance: 70, kind: 'preference' }]))
  store.saveGlobalCard(cardOf('global', [{ text: dupText, importance: 70, kind: 'preference' }]))
  const dupBlock = store.renderMemoryBlockRecalled(dupCwd, onCfg, '蓝桥杯嵌入式')
  eq(dupBlock.split(dupText).length - 1, 1, '项目卡 + 全局卡同一条只注入一次（按 text 去重）')

  // 取不到 query → 退回整卡，不注入空段
  eq(store.renderMemoryBlockRecalled(cwd, onCfg, ''), store.renderMemoryBlock(cwd, onCfg), 'query 为空退回整卡渲染')
  eq(store.renderMemoryBlockRecalled(cwd, onCfg, '   '), store.renderMemoryBlock(cwd, onCfg), 'query 只有空白也退回整卡')
}

console.log('固定区不参与预算裁剪（2026-10-30）：')
{
  const cwd = join(sandbox, 'proj-tiny')
  const longInitial = `我们的开始：${'第一次聊天'.repeat(30)}`
  const longPinned = `永远不会忘的：${'答应过的事'.repeat(30)}`
  store.saveProjectCard(cwd, createCard('project'))
  store.saveGlobalCard(cardOf('global', [
    { text: longInitial, importance: 90, kind: 'event', isInitial: true },
    { text: longPinned, importance: 90, kind: 'promise', pinned: true },
    { text: '树树想打蓝桥杯嵌入式赛道', importance: 40, kind: 'preference' }
  ]))

  // 预算压到下限 400：固定区两条加起来已经超了，也必须完整保留
  const tiny = store.renderMemoryBlockRecalled(cwd, normalizeConfig({ injectMaxChars: 400 }), '蓝桥杯')
  ok(tiny.includes(longInitial), '预算再小，「我们的开始」也完整保留')
  ok(tiny.includes(longPinned), '预算再小，「永远不会忘的」也完整保留')
  ok(tiny.length > 400, `固定区超预算时宁可超出（实际 ${tiny.length} 字）`)
}

console.log('兜底回填：预算用满但不超（2026-10-30）：')
{
  const cwd = join(sandbox, 'proj-fill')
  const specs = []
  for (let i = 0; i < 60; i += 1) {
    specs.push({ text: `最近记得的琐事第 ${i} 条：${'日常'.repeat(6)}`, importance: 30, kind: 'event', clarity: 'clear' })
  }
  specs.push({ text: '树树的目标是嵌入式工程师', importance: 80, kind: 'fact' })
  store.saveProjectCard(cwd, createCard('project'))
  store.saveGlobalCard(cardOf('global', specs))

  const cfg = normalizeConfig({ memoryRecall: true, injectMaxChars: 1200 })
  const block = store.renderMemoryBlockRecalled(cwd, cfg, '随便说点什么')
  // 末尾那句「觉得该记住的…」和旧路径一样挂在预算之外，比较时把它剥掉
  const body = block.split('\n\n觉得该记住的')[0]
  ok(body.length <= 1200, `回填不超过预算（实际 ${body.length} / 1200）`)
  ok(body.length > 900, `预算基本用满（实际 ${body.length}）`)
  ok(block.includes('## 最近记得的') || block.includes('## 关于你的事'), '回填用的是现有分区（最近记得的 / 关于你的事）')
}

console.log('取当前用户消息（2026-10-30）：')
{
  const events = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '早上好' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, data: { content: [{ type: 'text', text: '早' }], source: { kind: 'model' } } },
    { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '当前时间是 2026 年 10 月 30 日' }], source: { kind: 'time-context' } } },
    { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: '（QQ 私聊·用户本人 QQ 12345678）蓝桥杯想报嵌入式赛道' }], source: { kind: 'user' } } }
  ]
  const agent = {
    session: {
      header: { id: 'session-test', cwd: '' },
      seq: 4,
      firstLiveSeq: 0,
      snapshotEvents: (from, to) => events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
    }
  }
  eq(extract.currentUserText(agent), '蓝桥杯想报嵌入式赛道', '取最新的人话，并剥掉桥接信封')
  eq(extract.currentUserText({ agent: null }), '', '拿不到 session 返回空串')
  eq(extract.currentUserText({ session: { seq: 4, snapshotEvents: () => [] } }), '', '事件为空返回空串')
  eq(extract.currentUserText({
    session: {
      seq: 1,
      snapshotEvents: () => [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '系统注入' }], source: { kind: 'runtime-context' } } }]
    }
  }), '', '注入来源不当 query')

  // 2026-10-30：桥把她的回复原样回显成 user/message，不能拿她自己的话当 query
  const echoEvents = [
    { type: 'assistant/message', seq: 1, data: { content: [{ type: 'text', text: '唔…早上好喵~' }], source: { kind: 'model' } } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '（QQ 私聊·用户本人 QQ 12345678）唔…早上好喵~' }], source: { kind: 'user' } } }
  ]
  const echoAgent = {
    session: {
      seq: 2,
      firstLiveSeq: 0,
      snapshotEvents: (from, to) => echoEvents.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
    }
  }
  eq(extract.currentUserText(echoAgent), '', '助手原话的回显不当 query（退回整卡）')

  // 2026-10-30：去掉空白不到 4 个字，召回没有意义，返回空串
  const shortEvents = [
    { type: 'assistant/message', seq: 1, data: { content: [{ type: 'text', text: '好' }], source: { kind: 'model' } } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: ' 嗯 嗯 ' }], source: { kind: 'user' } } }
  ]
  const shortAgent = {
    session: {
      seq: 2,
      firstLiveSeq: 0,
      snapshotEvents: (from, to) => shortEvents.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
    }
  }
  eq(extract.currentUserText(shortAgent), '', '去掉空白后不足 4 字返回空串')
}

console.log('清理：')
rmSync(sandbox, { recursive: true, force: true })
ok(true, '临时目录已删')

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
