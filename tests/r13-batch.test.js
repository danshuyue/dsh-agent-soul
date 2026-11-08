/**
 * R13 · KNOWN-ISSUES 剩余项修复（2026-11-08，外部复检轮）
 *
 *   #8  maxRecords 两处口径统一 [20, 5000]
 *   #12 控制字符黑名单补 C1 区 + U+2028/2029（换行/制表仍放行）
 *   #13 mergeCards stats 补 decayed，lastDecayAt 取较新
 *   #14 补 id 的哈希掺 scope，跨卡同文本不同 scope 不再撞 id
 *   #16 diaryWindowOf 对 NaN 月/日显式返回空窗
 *   #19 moodDigest 跳过 kind==='decay' 的模板句
 *   #10 readBody 超限 reject 的错误带 status=413
 *   #17 日志轮转同分钟撞名时追加序号，两份归档都留得住
 *   #6  mood 缓存 key 全局化：写失败 settle 后其它 cwd 读到新值而不是旧值
 *   #30 无 id 会话游标按 agent 身份分键，不互吃扫描窗口
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r13-'))
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

const middleware = await imp('http/middleware.js')
const { validateConfigEntry } = middleware
const card = await imp('memory/card.js')
const { mergeCards, normalizeCard } = card
const compose = await imp('diary/compose.js')
const { diaryWindowOf } = compose
const digest = await imp('mood/digest.js')
const { moodDigest } = digest
const env = await imp('env.js')
const { appendLogLine, sanitizeLogText, note } = env
const paths = await imp('paths.js')
const { ensureDirs, agentsDir, __setAtomicWriteFailureForTest } = paths
const moodStateMod = await imp('state/mood-state.js')
const { moodState, saveMoodState } = moodStateMod
const extract = await imp('extract.js')
const { collectCandidates, commitIngestBatch } = extract

ensureDirs()

// ---------------------------------------------------------------------------
console.log('#8 · maxRecords 两处口径统一 [20, 5000]')
// ---------------------------------------------------------------------------
eq(validateConfigEntry('maxRecords', 20).ok, true, '下界 20 通过（旧 HTTP 口径会拒）')
eq(validateConfigEntry('maxRecords', 5000).ok, true, '上界 5000 通过（旧 HTTP 口径会拒）')
eq(validateConfigEntry('maxRecords', 10).ok, false, '低于 20 被拒')
eq(validateConfigEntry('maxRecords', 5001).ok, false, '高于 5000 被拒')

// ---------------------------------------------------------------------------
console.log('#12 · 控制字符黑名单补 C1 区与 U+2028/2029')
// ---------------------------------------------------------------------------
eq(validateConfigEntry('ownerName', '正常文本').ok, true, '普通文本放行')
eq(validateConfigEntry('ownerName', '多行\n文本\t也行').ok, true, '换行/制表仍放行（语气多行文本）')
eq(validateConfigEntry('ownerName', '坏\u0085吗').ok, false, 'C1 区 NEL（U+0085）被拒')
eq(validateConfigEntry('ownerName', '坏\u2028吗').ok, false, '行分隔符 U+2028 被拒')
eq(validateConfigEntry('ownerName', '坏\u2029吗').ok, false, '段分隔符 U+2029 被拒')

// ---------------------------------------------------------------------------
console.log('#13 · mergeCards stats 补 decayed / lastDecayAt 取较新')
// ---------------------------------------------------------------------------
{
  const mine = normalizeCard({ records: [], stats: { decayed: 2, lastDecayAt: 100 } })
  const theirs = normalizeCard({ records: [], stats: { decayed: 7, lastDecayAt: 500 } })
  const merged = mergeCards(mine, theirs).card
  eq(merged.stats.decayed, 7, 'decayed 取两边较大值（原来漏了，取到 base 的 2）')
  eq(merged.stats.lastDecayAt, 500, 'lastDecayAt 取较新（原来 spread 固定取 base 的 100）')
  const mergedBack = mergeCards(theirs, mine).card
  eq(mergedBack.stats.decayed, 7, '交换方向后 decayed 仍取较大值')
}

// ---------------------------------------------------------------------------
console.log('#14 · 补 id 的哈希掺 scope，跨卡同文本不再撞 id')
// ---------------------------------------------------------------------------
{
  const text = 'R14 同文本同时间的记录'
  const createdAt = '2026-01-01T00:00:00.000Z'
  const a = normalizeCard({ scope: 'global', records: [{ text, createdAt }] })
  const b = normalizeCard({ scope: 'project', records: [{ text, createdAt, scope: 'project' }] })
  const merged = mergeCards(a, b).card
  eq(merged.records.length, 2, '同文本同时间、scope 不同 → 补出的 id 不同，合并后保留两条（原来误并成一条）')
  ok(a.records[0].id !== b.records[0].id, '两条补 id 的记录 id 确实不同')
}

// ---------------------------------------------------------------------------
console.log('#16 · diaryWindowOf 对 NaN 月/日返回空窗')
// ---------------------------------------------------------------------------
eq(diaryWindowOf('2026-xx-01'), { since: 0, until: 0 }, '坏月份 → 空窗（原来静默算成 1 月）')
eq(diaryWindowOf('2026-11-8x'), { since: 0, until: 0 }, '坏日期 → 空窗')
{
  const good = diaryWindowOf('2026-11-08')
  ok(good.until - good.since === 24 * 60 * 60 * 1000, '正常日期仍是 24 小时窗')
}

// ---------------------------------------------------------------------------
console.log('#19 · moodDigest 跳过 decay 模板句')
// ---------------------------------------------------------------------------
{
  const now = Date.now()
  const states = [{
    mood: 50,
    timeline: [
      { at: now - 1000, mood: 55, delta: 5, reason: '她聊到了开心的事', kind: 'turn' },
      { at: now - 500, mood: 55, delta: 0, reason: '过了几个钟头，刚才那点劲儿慢慢淡了', kind: 'decay' }
    ]
  }]
  const out = moodDigest(states, { since: now - 60_000, until: now + 60_000 })
  const text = JSON.stringify(out)
  ok(!text.includes('慢慢淡了'), 'decay 模板句不进日记素材（原来会挤占 maxMoments 名额）')
  ok(text.includes('开心的事'), '真实波动条目保留')
}

// ---------------------------------------------------------------------------
console.log('#10 · readBody 超限的 reject 带 status=413')
// ---------------------------------------------------------------------------
{
  const { MAX_BODY } = await imp('http/constants.js')
  const req = new EventEmitter()
  req.destroy = function () { this.destroyed = true }
  const promise = middleware.readBody(req)
  const errPromise = promise.then(() => null, (e) => e)
  req.emit('data', Buffer.alloc(Number(MAX_BODY) + 1))
  const err = await errPromise
  ok(err !== null, '超限被拒')
  eq(err?.status, 413, '错误带 status=413（全局 catch 据此回 413 而不是 500）')
  ok(String(err?.message).includes('请求体太大'), '错误文案可读')
}

// ---------------------------------------------------------------------------
console.log('#17 · 轮转归档同分钟撞名追加序号')
// ---------------------------------------------------------------------------
{
  const big = 'x'.repeat(2 * 1024 * 1024 + 100)
  ok(appendLogLine(big) === true, '第一段大日志写入')
  ok(appendLogLine(big) === true, '第二段触发轮转（同一分钟内）')
  ok(appendLogLine(big) === true, '第三段再次轮转')
  const archives = readdirSync(agentsDir()).filter((n) => /^soul\.log\.\d{8}-\d{4}(-\d+)?$/.test(n))
  ok(archives.length >= 2, `同一分钟的两份归档都留住了（共 ${archives.length} 份：${archives.join(', ')}）`)
  ok(archives.some((n) => /-\d+$/.test(n)), '撞名的归档带序号后缀')
}

// ---------------------------------------------------------------------------
console.log('#6 · mood 缓存 key 全局化：写失败 settle 后其它 cwd 读到新值')
// ---------------------------------------------------------------------------
{
  const base = moodState('workspace-a')
  const next = { ...base, mood: 88 }
  __setAtomicWriteFailureForTest(() => ({ ok: false, error: '注入的写盘失败' }))
  const failedWrite = saveMoodState('workspace-a', next)
  eq(failedWrite.ok, false, '注入失败：写盘确实失败')
  const seenFromOtherCwd = moodState('workspace-b')
  eq(seenFromOtherCwd.mood, 88, '从另一个 cwd 读，拿到的是 settle 后的内存新值（原来 B 的缓存条目仍是旧值）')
  __setAtomicWriteFailureForTest(null)
}

// ---------------------------------------------------------------------------
console.log('#30 · 无 id 会话游标按 agent 身份分键')
// ---------------------------------------------------------------------------
{
  const human = (seq, text) => ({
    type: 'user/message', seq,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } }
  })
  // 会话 A：先基线（推游标），再来一批真实消息并落盘推进游标
  const eventsA = [human(1, 'A 的开场白')]
  const agentA = { session: { events: eventsA } } // 无 id
  const first = collectCandidates(agentA)
  eq(first.candidates.length, 0, 'A 首次：基线，不回扫')
  eq(first.from, 1, 'A 的游标起点是自己的 maxSeq')
  eventsA.push(human(5, 'A 说了一件事'), human(6, 'A 又说了一件事'))
  const second = collectCandidates(agentA)
  ok(second.batch !== null, 'A 的第二批被扫到')
  commitIngestBatch(second.batch)
  // 会话 B：事件 seq 比 A 的游标小。老实现共享 'default' 游标 → B 的 from=6，
  // 自己的 seq 5 永远扫不到（静默丢记忆）。新实现 B 有自己的键。
  const eventsB = [human(5, 'B 说了一件只有 B 有的事')]
  const agentB = { session: { events: eventsB } } // 无 id，不同对象
  const bFirst = collectCandidates(agentB)
  eq(bFirst.from, 5, `B 首次的游标起点是自己的 maxSeq=5（老实现会是 A 推进后的 6）`)
  eventsB.push(human(7, 'B 后来说的话'))
  const bSecond = collectCandidates(agentB)
  eq(bSecond.scanned, 1, 'B 的新事件能被扫到（不被 A 的游标挡住）')
}

// ---------------------------------------------------------------------------
console.log('附加 · sanitizeLogText 基础行为（#9 的支撑函数）')
// ---------------------------------------------------------------------------
eq(sanitizeLogText('abc\n[api] 假的'), 'abc?[api] 假的', '换行被换成 ?，日志行拆不开')
eq(sanitizeLogText('a'.repeat(300)).length, 200, '超长截到 200')

// ---------------------------------------------------------------------------
console.log('#1 · 只读头部不能把 UTF-8 汉字切坏（复核补丁）')
// ---------------------------------------------------------------------------
{
  // 2026-11-08 复核发现：#1 原先按 400 字节直接 toString('utf8')，而 400 % 3 != 0，
  // 中文正文的最后一个字必然被切开，预览末尾出现 U+FFFD（「�」）。
  // 这里走真实 handler，拿真实 preview 断言。
  const completion = await imp('diary/completion.js')
  const diary = await imp('http/routes/diary.js')
  const dateStr = completion.todayKey(Date.now())
  const file = paths.diaryPublicPath(dateStr)
  mkdirSync(dirname(file), { recursive: true })
  // 关键：让 400 字节边界**正好切在汉字中间**。
  // 纯中文正文：每字 3 字节，400 % 3 = 1 → 第 400 字节必是某个字的第一个字节。
  // （第一版测试在前面加了「【公开】+ 日期」前缀，前缀 25 字节让 375 恰好整除 3，
  //   边界落在字与字之间 —— 于是无论修没修都不会出现 U+FFFD，测试是假绿。）
  writeFileSync(file, '这是一段中文正文用来测试截断边界'.repeat(40), 'utf8')

  const res = { status: 0, body: '' }
  await diary.handleGetDiaryList({}, {}, {
    writeHead(code) { res.status = code },
    end(chunk) { res.body += String(chunk) },
    writableEnded: false
  }, new URLSearchParams('days=1'), '/diary/list')

  const parsed = JSON.parse(res.body)
  const item = (parsed.list ?? []).find((row) => row.date === dateStr)
  ok(item !== undefined, '列表里有今天这一条')
  const preview = String(item?.preview ?? '')
  ok(preview.length > 0, '预览非空')
  ok(!preview.includes('\uFFFD'), '预览里没有替换字符（旧实现这里必然有）')
  ok(preview.length >= 120, `预览取到了足够内容（${preview.length} 字）`)
  // 读取上限：多读 3 字节只是为了补齐字符，不应明显变长
  ok(Buffer.byteLength(preview, 'utf8') <= 403, `预览字节数没超上限（${Buffer.byteLength(preview, 'utf8')}）`)

  rmSync(file, { force: true })
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
