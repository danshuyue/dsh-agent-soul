/**
 * 记忆引擎测试：node tests/memory.test.js，退出码 0 = 全过。
 *
 * 只测纯函数，不碰 ~/.dsh（存档那一段用系统临时目录）。
 * 重点覆盖「会静默出错」的地方：正则状态、保护规则、预算裁剪、压缩豁免。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLARITY_ORDER,
  DAY_MS,
  addRecord,
  applyDecay,
  compactCard,
  createCard,
  daysSince,
  emotionScore,
  forgetRecord,
  loadCard,
  makeArchiver,
  normalizeConfig,
  recall,
  recallArchived,
  redact,
  renderCard,
  saveCard,
  scoreRecord,
  setPinned,
  status,
  targetClarity,
  touchRecords
} from '../lib/memory.js'

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

const cfg = normalizeConfig({})
const DAY = DAY_MS

console.log('打分：')
{
  const owner = scoreRecord({ text: '树树说下次一起把补历史功能补完', isOwner: true, isPrivate: true })
  ok(owner.importance >= 60, `主人的约定分够高（${owner.importance}）`)
  ok(owner.tags.includes('owner') && owner.tags.includes('promise'), '标签带 owner + promise')
  ok(owner.reasons.length > 0, '给了加分理由（设置页要能解释）')

  const noise = scoreRecord({ text: '嗯' })
  eq(noise.importance, 0, '「嗯」这种不给分')

  const plain = scoreRecord({ text: '随手记了一条无关紧要的消息内容' })
  ok(plain.importance < 20, `普通句子低分（${plain.importance}）`)

  const manual = scoreRecord({ text: '随便什么内容都行', importance: 88 })
  eq(manual.importance, 88, '手动指定优先')

  const emo = scoreRecord({ text: '我好难过，真的很委屈，想哭' })
  ok(emo.importance > plain.importance, '情绪浓度会加分')
  ok(emo.tags.includes('emotional'), '情绪高的打 emotional 标签')
}

console.log('情绪与脱敏：')
{
  ok(emotionScore('谢谢你，真的很感动') > 0, '强情绪词能识别')
  eq(emotionScore('今天下午三点开会'), 0, '普通句子情绪分 0')
  ok(emotionScore('开心开心开心') <= 24, '情绪分有上限')

  ok(redact('我的 key 是 sk-abcdefgh12345').includes('[密钥]'), '密钥被抹掉')
  ok(redact('手机号 13812345678 记一下').includes('[手机号]'), '手机号被抹掉')
  ok(redact('看这个 https://example.com/a?b=1 挺好').includes('[链接]'), '链接被抹掉')
  ok(!redact('普通的一句话不该被改动').includes('['), '普通文本不被误伤')
}

console.log('定档与衰减：')
{
  const now = Date.now()
  const fresh = { createdAt: new Date(now - 1 * DAY).toISOString(), lastSeenAt: new Date(now).toISOString(), importance: 30, clarity: 'vivid' }
  eq(targetClarity(fresh, cfg, now), 'clear', '1 天前、重要度 30 → 清楚（近期加成）')

  const old = { createdAt: new Date(now - 100 * DAY).toISOString(), lastSeenAt: new Date(now - 100 * DAY).toISOString(), importance: 20, clarity: 'clear' }
  eq(targetClarity(old, cfg, now), 'forgotten', '100 天前、重要度 20 → 遗忘')

  const pinned = { ...old, pinned: true }
  eq(targetClarity(pinned, cfg, now), 'vivid', 'pinned 永远清晰')

  const ownerFact = { ...old, importance: 30, tags: ['owner', 'self'] }
  ok(['clear', 'fuzzy'].includes(targetClarity(ownerFact, cfg, now)), `主人的长期事实不会遗忘（${targetClarity(ownerFact, cfg, now)}）`)

  const first = { ...old, importance: 20, tags: ['first'] }
  ok(['clear', 'fuzzy'].includes(targetClarity(first, cfg, now)), '「第一次」类的事不会遗忘')

  const groupFriend = { ...old, importance: 20, tags: ['self'] }
  eq(targetClarity(groupFriend, cfg, now), 'forgotten', '没有 owner 的 self 标签不受保护（群友的自称不该永久留着）')
}

console.log('衰减过程（一天一档）：')
{
  const now = Date.now()
  const card = createCard('global')
  const t0 = now - 60 * DAY
  const r = addRecord(card, { text: '一条普通的记录，内容足够长可以入卡', source: 'test' }, cfg, t0)
  r.record.clarity = 'vivid'
  const one = applyDecay(card, cfg, t0 + DAY, { force: true, steps: 1 })
  eq(r.record.clarity, 'clear', '一天只降一档')
  ok(one.changed === true, '报告了变化')

  const sameDay = applyDecay(card, cfg, t0 + DAY, { force: false })
  eq(sameDay.changed, false, '同一天再跑不重复降档')

  // 补跑：关了一周
  // ⚠️ 日期必须按【本地】取，不能用 toISOString()（那是 UTC 日期）：
  // daysSince 是把 'YYYY-MM-DD' 当本地午夜解析的（生产侧的 dateKey 也是本地口径），
  // 混着用会在 UTC+8 的凌晨 0~8 点差一天 —— 表现为「补跑天数」测试时好时坏。
  const ymdLocal = (ts) => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  eq(daysSince(ymdLocal(t0 + DAY), t0 + 8 * DAY), 7, '补跑天数算对了')
  eq(daysSince(null, now), 1, '没有记录时按 1 天')
  eq(daysSince('2000-01-01', now), 30, '补跑有 30 天上限')
}

console.log('写入与去重：')
{
  const now = Date.now()
  const card = createCard('global')
  const first = addRecord(card, { text: '树树喜欢喝冰美式', isOwner: true, source: 'tool' }, cfg, now)
  ok(first.ok === true && first.deduped !== true, '第一次写入成功')
  eq(card.records.length, 1, '卡里一条')

  const again = addRecord(card, { text: '树树喜欢喝冰美式', isOwner: true, source: 'auto' }, cfg, now + 1000)
  ok(again.deduped === true, '同样的话不再新增')
  eq(card.records.length, 1, '仍然一条')
  eq(again.record.recallCount, 1, '改成复习：召回次数 +1')

  const empty = addRecord(card, { text: '   ' }, cfg, now)
  eq(empty.ok, false, '空文本被拒')
}

console.log('复习回升：')
{
  const now = Date.now()
  const card = createCard('global')
  const r = addRecord(card, { text: '这件事被记下来过，后来又提起了', source: 'test' }, cfg, now)
  r.record.clarity = 'trace'
  const touched = touchRecords(card, [r.record.id], now + 1000)
  eq(touched, 1, '复习命中一条')
  eq(r.record.clarity, 'fuzzy', '从「只剩印象」回升到「模糊」')
  eq(r.record.recallCount, 1, '召回次数 +1')
}

console.log('渲染：')
{
  const now = Date.now()
  const card = createCard('global')
  addRecord(card, { text: '这是第一次和树树说话，在三月的一个雨天', isOwner: true, isFirst: true, source: 'test' }, cfg, now)
  const pinned = addRecord(card, { text: '树树的目标是嵌入式工程师，偏软件方向', isOwner: true, source: 'test' }, cfg, now)
  setPinned(card, pinned.record.id, true)
  const fuzzy = addRecord(card, { text: '在群里聊到过一句关于数学建模的事，具体内容已经记不太清了', source: 'test' }, cfg, now)
  fuzzy.record.clarity = 'fuzzy'
  const trace = addRecord(card, { text: '好像还提过一次跟硬件选型有关的事，细节全忘了', source: 'test' }, cfg, now)
  trace.record.clarity = 'trace'

  const out = renderCard(card, { config: cfg, now })
  ok(out.includes('【记忆卡'), '有标题')
  ok(out.includes('我们的开始') || out.includes('永远不会忘的'), '锚点分区存在')
  ok(out.includes('细节记不清了'), '模糊的记忆明说记不清')
  ok(out.includes('好像有') && out.includes('想不起来了'), '只剩印象的用「好像有…想不起来」')
  ok(out.includes('不要编'), '提示词里明确禁止编造')

  // 预算裁剪：极小的预算下整条剔除低优先级内容，而不是切断半句
  const tiny = renderCard(card, { config: cfg, maxChars: 210, now })
  ok(tiny.length <= 220, `预算裁剪生效（${tiny.length} 字）`)
  ok(!tiny.includes('数学建模'), '最低优先级（正在模糊的）被整条剔除')
  ok(tiny.includes('嵌入式工程师'), '高优先级（固定的锚点）保留下来')
  ok(!tiny.endsWith('，'), '没有把句子切断在半截')

  const empty = renderCard(createCard('global'), { config: cfg, now })
  eq(empty, '', '空卡不往提示词里塞空壳')
}

console.log('容量压缩：')
{
  const now = Date.now()
  const card = createCard('global')
  for (let i = 0; i < 40; i += 1) {
    addRecord(card, { text: `第 ${i} 条普通记忆，内容长度中等，用来把卡撑到需要压缩的程度`, source: 'test' }, cfg, now - i * 1000)
  }
  const keep = addRecord(card, { text: '这条是固定的锚点，压缩时不该被淘汰', source: 'test' }, cfg, now)
  setPinned(card, keep.record.id, true)
  const before = card.records.length
  const smallCfg = normalizeConfig({ warnChars: 1200 })
  const steps = compactCard(card, smallCfg, { now })
  ok(steps > 0, `压缩做了事（${steps} 步）`)
  ok(card.records.length < before, '条数确实减少了')
  ok(card.records.some((record) => record.id === keep.record.id), 'pinned 的那条没被淘汰')
  ok(renderCard(card, { config: smallCfg, full: true, now }).length <= 1200, '压缩后落在预算内')
}

console.log('检索：')
{
  const now = Date.now()
  const card = createCard('global')
  addRecord(card, { text: '树树在做 STM32 的串口通信实验，卡在中断配置', isOwner: true, source: 'test' }, cfg, now)
  addRecord(card, { text: '今天天气不错，去操场跑了三公里', source: 'test' }, cfg, now)
  addRecord(card, { text: '树树说 STM32 的时钟树好难理解', isOwner: true, source: 'test' }, cfg, now)

  const hits = recall(card, 'STM32 中断')
  ok(hits.length >= 1, `搜到了 ${hits.length} 条`)
  ok(hits[0].record.text.includes('STM32'), '第一条确实相关')
  eq(recall(card, '').length, 0, '空查询返回空')
  eq(recall(card, '完全不存在的关键词组合').length, 0, '搜不到就是搜不到')
}

console.log('忘记与存档：')
{
  const dir = mkdtempSync(join(tmpdir(), 'soul-test-'))
  const file = join(dir, 'archive.jsonl')
  const archive = makeArchiver(file)
  const card = createCard('global')
  const r = addRecord(card, { text: '这条准备被忘掉，内容够长', source: 'test' }, cfg, Date.now())
  const removed = forgetRecord(card, r.record.id, archive)
  ok(removed !== null, '忘掉返回了被删的记录')
  eq(card.records.length, 0, '卡里没了')

  const lines = readFileSync(file, 'utf8').trim().split('\n')
  eq(lines.length, 1, '档案件写了一行')
  const found = recallArchived(file, '准备被忘掉')
  eq(found.length, 1, '能从档案件里捞回来')

  rmSync(dir, { recursive: true, force: true })
}

console.log('读写与状态：')
{
  const dir = mkdtempSync(join(tmpdir(), 'soul-test-'))
  const file = join(dir, 'card.json')
  const card = createCard('global')
  addRecord(card, { text: '写盘再读回来要一模一样', source: 'test' }, cfg, Date.now())
  saveCard(file, card)
  const back = loadCard(file)
  ok(back !== null, '读回来了')
  eq(back.records.length, 1, '条数一致')
  eq(back.records[0].text, '写盘再读回来要一模一样', '内容一致')

  const st = status(back, cfg)
  eq(st.count, 1, '统计条数对')
  eq(st.level, 'ok', '容量告急档位正常')
  ok(CLARITY_ORDER.includes(back.records[0].clarity), '清晰度是合法值')

  const broken = join(dir, 'broken.json')
  saveCard(broken, card)
  writeFileSync(broken, '{ 这不是 JSON', 'utf8')
  eq(loadCard(broken), null, '坏文件返回 null 而不是抛错')

  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
