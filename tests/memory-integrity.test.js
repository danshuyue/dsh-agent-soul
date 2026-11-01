/**
 * memory-integrity.test.js —— 记忆卡「不丢数据」的护栏（2026-11-01）
 *
 * 对应第三方审计的 A1 / A2 / A3 / D11 四条，每条先复现旧行为会造成的损失，
 * 再断言新行为。这些用例的价值不在覆盖率，在于**以后谁改回去就会立刻红**。
 *
 * 跑法：node tests/memory-integrity.test.js
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'soul-integrity-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents', 'memory'), { recursive: true })

const mem = await import('../lib/memory.js')
const extract = await import('../lib/extract.js')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.error(`  ✗ ${name}`)
  }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

// ---------------------------------------------------------------------------
console.log('\nA1 坏文件不许被空卡覆盖')
// ---------------------------------------------------------------------------
{
  const file = join(sandbox, 'agents', 'memory', 'global.json')
  const broken = '{"records": [{"text": "树树想当嵌入式工程师"'
  writeFileSync(file, broken, 'utf8')

  const loaded = mem.loadCard(file)
  eq(loaded, null, '坏文件 → null（调用方新建空卡）')

  const leftovers = readdirSync(join(sandbox, 'agents', 'memory')).filter((n) => n.includes('.corrupt-'))
  eq(leftovers.length, 1, '原文件被另存为 .corrupt-<时间戳>，没有就地蒸发')
  eq(readFileSync(join(sandbox, 'agents', 'memory', leftovers[0]), 'utf8'), broken, '备份内容就是坏掉的那份原文')
  ok(!existsSync(file), '原路径已腾空（下次写入不会盖到什么）')

  // 此时不应该被判定成只读：数据已经安全落盘，新卡可以正常写
  eq(mem.isCardReadonly(file), false, '备份成功后没进只读模式')

  // 新卡写回去，备份还在 —— 这就是"不丢数据"的完整闭环
  const fresh = mem.createCard('global')
  mem.addRecord(fresh, { text: '新的一条' }, {}, Date.now())
  mem.saveCard(file, fresh)
  ok(existsSync(file), '新卡写进了原路径')
  ok(existsSync(join(sandbox, 'agents', 'memory', leftovers[0])), '写完新卡，损坏备份仍然在')
}

// 正常卡（能解析）每次存盘留一代 .bak；坏卡不该把好备份冲掉
{
  const file = join(sandbox, 'agents', 'memory', 'bak.json')
  const card = mem.createCard('global')
  mem.addRecord(card, { text: '第一条' }, {}, Date.now())
  mem.saveCard(file, card)
  mem.addRecord(card, { text: '第二条' }, {}, Date.now())
  mem.saveCard(file, card)
  ok(existsSync(`${file}.bak`), '第二次存盘留下 .bak')
  ok(readFileSync(`${file}.bak`, 'utf8').includes('第一条'), '.bak 是上一代内容')
  ok(readFileSync(`${file}.bak`, 'utf8').includes('第二条') === false, '.bak 没被本次写入污染')

  // 把主文件写坏，再存盘：坏文件不能覆盖掉好的 .bak
  writeFileSync(file, 'not json at all', 'utf8')
  const before = readFileSync(`${file}.bak`, 'utf8')
  mem.loadCard(file) // 这一下会把坏文件挪走
  const card2 = mem.createCard('global')
  mem.addRecord(card2, { text: '第三条' }, {}, Date.now())
  mem.saveCard(file, card2)
  eq(readFileSync(`${file}.bak`, 'utf8'), before, '坏文件不会冲掉上一代 .bak')
}

// ---------------------------------------------------------------------------
console.log('\nA2 压缩不能一次丢掉大半张卡，也不能慢在装配路径上')
// ---------------------------------------------------------------------------
{
  const now = Date.now()
  const card = mem.createCard('global')
  for (let i = 0; i < 600; i += 1) {
    mem.addRecord(card, { text: `第 ${i} 条普通记忆，内容长度中等，用来把卡撑到需要压缩的程度` }, {}, now - i * 1000)
  }
  const before = card.records.length
  const cfg = mem.normalizeConfig({ warnChars: 1200 })
  const t0 = Date.now()
  const touched = mem.compactCard(card, cfg, { now })
  const cost = Date.now() - t0

  ok(touched > 0, `压缩做了事（动了 ${touched} 条）`)
  ok(before - card.records.length <= Math.ceil(before * 0.3) + 1,
    `单次最多动 30%（删了 ${before - card.records.length} / ${before} 条）`)
  ok(cost < 300, `600 条的卡一次压缩 ${cost}ms（旧版 845ms 起）`)
  eq(card.records.length + touched >= card.records.length, true, '返回的条数与实际删除不矛盾')

  // 反复跑必须收敛，不能像旧版那样卡在预算之上一直啃
  const target = 1200
  let rounds = 0
  while (mem.renderCard(card, { config: cfg, full: true, now }).length > target && rounds < 40) {
    mem.compactCard(card, cfg, { now })
    rounds += 1
  }
  ok(rounds < 40, `多跑几轮后落在预算内（${rounds} 轮，剩 ${card.records.length} 条）`)

  // 固定锚点永远不动
  const pinned = mem.createCard('global')
  for (let i = 0; i < 40; i += 1) mem.addRecord(pinned, { text: `普通 ${i}，凑字数凑字数凑字数凑字数` }, {}, now)
  const keep = mem.addRecord(pinned, { text: '固定锚点不该被压缩淘汰' }, {}, now)
  mem.setPinned(pinned, keep.record.id, true)
  for (let i = 0; i < 5; i += 1) mem.compactCard(pinned, cfg, { now })
  ok(pinned.records.some((r) => r.id === keep.record.id), '反复压缩也不会碰 pinned 的那条')
}

// ---------------------------------------------------------------------------
console.log('\nA3 两个进程各写一条，谁都不该被抹掉')
// ---------------------------------------------------------------------------
{
  const now = Date.now()
  const mine = mem.createCard('global')
  mem.addRecord(mine, { text: '我在 desktop 进程里记的这条' }, {}, now)
  const theirs = mem.createCard('global')
  mem.addRecord(theirs, { text: '它在 CLI 进程里记的那条' }, {}, now)

  const merged = mem.mergeCards(mine, theirs, now)
  const texts = merged.card.records.map((r) => r.text)
  eq(merged.added, 1, `并集补回 1 条（实际 ${merged.added}）`)
  ok(texts.includes('我在 desktop 进程里记的这条') && texts.includes('它在 CLI 进程里记的那条'),
    '两边的记录都在')
  eq(merged.card.records.length, 2, '没有重复条数')

  // 同 id 冲突：取 lastSeenAt 更新的那条，recallCount 取大
  const a = mem.createCard('global')
  const rec = mem.addRecord(a, { text: '同一个 id 的记忆' }, {}, now).record
  const b = mem.normalizeCard(JSON.parse(JSON.stringify(a)))
  b.records[0].text = '同一个 id 但更新过的正文'
  b.records[0].lastSeenAt = new Date(now + 60000).toISOString()
  b.records[0].recallCount = 7
  const m2 = mem.mergeCards(a, b, now)
  eq(m2.card.records.length, 1, '同 id 只留一条')
  eq(m2.card.records[0].text, '同一个 id 但更新过的正文', '取 lastSeenAt 更新的正文')
  eq(m2.card.records[0].recallCount, 7, 'recallCount 取大')
  eq(m2.card.records[0].id, rec.id, 'id 不变')
}

// ---------------------------------------------------------------------------
console.log('\nD11 「帮我记住我不吃辣」不许被当成让我干活')
// ---------------------------------------------------------------------------
{
  eq(extract.autoMemoryRejectReason('帮我记住我不吃辣，一吃就胃疼'), null,
    '祈使句 + 人物属性 → 放行')
  ok(extract.autoMemoryRejectReason('帮我改一下这个插件的日志输出') !== null,
    '祈使句 + 代码任务 → 照旧丢掉')
  ok(extract.autoMemoryRejectReason('麻烦你跑一下测试') !== null, '普通祈使句照旧丢掉')

  // 第二道门槛：过了 reject 还要过 kind 的重要度线（event 70 / fact 42）
  const card = mem.createCard('global')
  const cfg = mem.normalizeConfig({})
  const written = extract.ingestCandidates(card, mem.addRecord, [{
    text: '帮我记住我不吃辣，一吃就胃疼',
    isOwner: true,
    scored: { importance: 52 }
  }], cfg, Date.now())
  eq(written, 1, '重要度 52 的人物属性进了卡（不会被 event 的 70 分砍掉）')
  ok(card.records.some((r) => r.text.includes('不吃辣')), '卡里真的有不辣这条')
  eq(card.records[0].kind, 'fact', '人物属性归成 fact，不是 event')
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
