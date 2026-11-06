/**
 * 契约门禁 ③：行为 golden（2026-11-06 重构 P0）。
 *
 * 「零行为变化」不能靠读代码保证。这里用固定时钟 + 合成卡，跑记忆渲染、
 * 召回、衰减、日记拼装、心情摘要，把输出序列化成 sha256 冻起来。
 * 每批重构后哈希必须逐字节一致 —— 搬家搬错了，测试会红，而不是等用户发现。
 *
 * 记录 id 由 shortHash 生成、可能掺时间，构造后统一覆写成固定值，
 * 否则哈希会无意义地抖动。
 *
 * 首次运行生成快照；主动更新用 SOUL_UPDATE_SNAPSHOT=1。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { requireSnapshotReason } from './snapshot-policy.mjs'

// 2026-11-06 修：renderCard 的头部是「更新：2026/11/5 20:00:00」——按**本地时区**格式化。
// 基线在 Windows / UTC+8 上生成，CI 跑在 UTC，同一份代码算出来的哈希不同
// （长度都是 2428、字节不同），第一次推上去 CI 就红了。
// golden 要钉的是行为，不是构建机的时区，所以这里把 TZ 固定住。
// 必须在 import 任何 lib 模块之前设置：模块顶层一旦取过时间就锁住了。
process.env.TZ = 'UTC'

if (!process.env.DSH_HOME) process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'soul-golden-'))
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)
const snapshotFile = join(root, 'tests', 'contract', 'behavior-golden.json')

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

const memory = await imp('memory.js')
const diary = await imp('diary.js')
const mood = await imp('mood.js')

const NOW = Date.parse('2026-11-05T12:00:00Z')
const cfg = memory.normalizeConfig({})
const TEXTS = [
  '树树在学 STM32 嵌入式',
  '他参加了工创赛新能源小车',
  '薇薇会写日记和记忆',
  '树树喜欢用 Arduino IDE 和 Keil',
  '今天聊了蓝桥杯嵌入式赛道'
]
function makeCard() {
  const card = memory.createCard('global', NOW)
  TEXTS.forEach((text, i) => {
    memory.addRecord(card, { text, importance: 60 + i }, cfg, NOW - i * 3600_000)
  })
  card.records.forEach((record, i) => { record.id = `fixed-${i}` })
  return card
}

const card = makeCard()
const decayed = makeCard()
const decayReport = memory.applyDecay(decayed, cfg, NOW + 3 * 86400_000, { force: true })

const behavior = {
  renderCard: memory.renderCard(card, { config: cfg, now: NOW, full: true }),
  renderCardCapped: memory.renderCard(card, { config: cfg, now: NOW, maxChars: 400 }),
  recall: memory.recall(card, 'STM32 嵌入式', { limit: 5 })
    .map((hit) => ({ text: hit.record?.text, score: hit.score })),
  renderRecalledBlock: memory.renderRecalledBlock([card], { config: cfg, now: NOW, query: 'STM32' }),
  renderRecallOnly: memory.renderRecallOnly([card], { config: cfg, now: NOW, query: '蓝桥杯' }),
  status: memory.status(card, cfg),
  decay: {
    reportKeys: Object.keys(decayReport ?? {}).sort(),
    clarities: decayed.records.map((r) => `${r.text}|${r.clarity}`)
  },
  composePublic: diary.composePublicMessage(cfg, '2026-11-05', '今天聊了 STM32 和日记',
    { public: '昨天的公开日记' }, '心情不错', ''),
  composePrivate: diary.composePrivateMessage(cfg, '2026-11-05', '今天聊了 STM32 和日记',
    { public: '昨天的公开日记', private: '昨天的私密日记' }, '心情不错', ''),
  moodDigestEmpty: mood.moodDigest([], { since: 0, until: 0 })
}

const serialized = JSON.stringify(behavior)
const hash = createHash('sha256').update(serialized).digest('hex')

console.log('行为 golden：')
ok(serialized.length > 500, `golden 输出有实质内容（${serialized.length} 字符）`)
console.log(`  · sha256 ${hash}`)

// 2026-11-06 第二份审查 H-4：基线缺失时不许静默重建（同 exports.snapshot 的理由）。
if (!existsSync(snapshotFile) && process.env.SOUL_UPDATE_SNAPSHOT !== '1') {
  ok(false, `基线文件存在（${relative(root, snapshotFile)} 缺失时不许静默重建；首次生成请显式 SOUL_UPDATE_SNAPSHOT=1）`)
} else if (!existsSync(snapshotFile) || process.env.SOUL_UPDATE_SNAPSHOT === '1') {
  const existed = existsSync(snapshotFile)
  // 2026-11-06 P11：改行为 golden 必须写明理由并留痕，防「刷基线消红」。
  if (existed) requireSnapshotReason(root, 'behavior-golden.json')
  writeFileSync(snapshotFile, `${JSON.stringify({ hash, length: serialized.length, cases: Object.keys(behavior).sort() }, null, 2)}\n`, 'utf8')
  console.log(`  · 已${existed ? '更新' : '生成'}快照：${relative(root, snapshotFile)}`)
} else {
  const expected = JSON.parse(readFileSync(snapshotFile, 'utf8'))
  ok(expected.hash === hash, `哈希与基线一致（基线 ${String(expected.hash).slice(0, 16)}…）`)
  ok(expected.length === serialized.length, `输出长度一致（${serialized.length}）`)
  ok(JSON.stringify(expected.cases) === JSON.stringify(Object.keys(behavior).sort()), '覆盖的行为项集合不变')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
