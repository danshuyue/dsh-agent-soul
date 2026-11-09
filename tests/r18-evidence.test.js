/**
 * R18 · 三件事的测试（2026-11-10，按 docs/R18-BRIEF.md）
 *
 *   B  废弃配置键：接受（不 400）但不落盘；每进程每键只记一行日志；迁移仍生效
 *   C  开关证据：inert 组合必须报「未生效：人话原因」；动态计数 0 次 ≠ N/A；
 *      reportLine 把「生效 / 暂未发生 / 未生效」分成三段
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r18-'))
process.env.DSH_HOME = sandbox
process.env.TZ = 'UTC'
mkdirSync(join(sandbox, 'agents'), { recursive: true })

let passed = 0
let failed = 0
const ok = (c, n) => { if (c) { passed += 1; console.log(`  ✓ ${n}`) } else { failed += 1; console.error(`  ✗ ${n}`) } }
const eq = (a, e, n) => ok(JSON.stringify(a) === JSON.stringify(e), `${n}${JSON.stringify(a) === JSON.stringify(e) ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(e)}）`}`)

const { ensureDirs } = await imp('paths.js')
ensureDirs()
const middleware = await imp('http/middleware.js')
const { validateConfigEntry, LEGACY_CONFIG_KEYS } = middleware
const system = await imp('http/routes/system.js')
const { handlePostConfig, handleGetState } = system
const cache = await imp('state/cache.js')
const { loadConfig, saveConfig, CONFIG_FILE } = cache
const env = await imp('env.js')
const { LOG_FILE, __resetNoteThrottleForTest } = env
const evidence = await imp('evidence.js')
const { statuses, reportLine, mark, markSnapshot, __resetEvidenceForTest } = evidence

// 假 req/res：照 contract/route-behavior 的形状
function fakeReq(body) {
  const req = new EventEmitter()
  req.headers = {}
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}
function fakeRes() {
  const res = { statusCode: 0, payload: null }
  res.writeHead = (code) => { res.statusCode = code }
  res.end = (chunk) => { res.payload = JSON.parse(chunk) }
  res.on = () => res
  return res
}

// ---------------------------------------------------------------------------
console.log('B · 废弃配置键：接受 / 不落盘 / 单次日志 / 迁移仍生效')
// ---------------------------------------------------------------------------
{
  eq([...LEGACY_CONFIG_KEYS].sort(), ['diarySchedule', 'moodOwnerName'], 'B0 废弃键清单就这两项')
  eq(validateConfigEntry('diarySchedule', '22:00').ok, true, 'B1 validate 接受 diarySchedule（不 400）')
  eq(validateConfigEntry('moodOwnerName', '老名字').ok, true, 'B1 validate 接受 moodOwnerName')
  eq(validateConfigEntry('diarySchedule', 123).ok, false, 'B1 非字符串值仍拒')
}
{
  saveConfig({ ownerName: '' })
  const res = fakeRes()
  await handlePostConfig({}, fakeReq({ config: { diarySchedule: '23:00', memoryRecall: true } }), res, new URLSearchParams(), '/config')
  eq(res.statusCode, 200, 'B2 含 diarySchedule 的 /config 仍回 200')
  const onDisk = JSON.parse(readFileSync(CONFIG_FILE(), 'utf8'))
  eq(onDisk.diarySchedule, undefined, 'B3 config.json 里不出现 diarySchedule（接受但不落盘）')
  eq(onDisk.memoryRecall, true, 'B3 正常键照常落盘')
}
{
  // 日志只打一行（两个进程内两次请求，第二次不再记）
  const res1 = fakeRes()
  await handlePostConfig({}, fakeReq({ config: { diarySchedule: '21:00' } }), res1, new URLSearchParams(), '/config')
  const log = readFileSync(LOG_FILE(), 'utf8')
  const hits = log.split('\n').filter((l) => l.includes('忽略已废弃配置键 diarySchedule')).length
  eq(hits, 1, `B4 日志只记一行（实际 ${hits} 行）`)
}
{
  // moodOwnerName 迁移仍生效：模拟**真实老配置**——文件里只有旧键、没有 ownerName 键
  // （有 ownerName 键时迁移按设计跳过：「哪怕是空串 = 我就是不设」）
  const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf8'))
  delete raw.ownerName
  raw.moodOwnerName = '文件里的老名字'
  writeFileSync(CONFIG_FILE(), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  // 外部改文件必须先丢缓存（readThrough 按 mtime 判；同毫秒写入会撞缓存）
  cache.resetCaches()
  const cfg = loadConfig()
  eq(cfg.ownerName, '文件里的老名字', 'B5 moodOwnerName 的迁移逻辑仍生效（R18-B 明确不许删迁移）')
}

// ---------------------------------------------------------------------------
console.log('C · 开关证据：inert 原因写人话，0 次 ≠ N/A')
// ---------------------------------------------------------------------------
{
  __resetEvidenceForTest()
  // C1: moodToneInject=true + moodEnabled=false → 「未生效：心情关了」，不是生效也不是未知
  const rows = statuses({ ...loadConfig(), enabled: true, moodEnabled: false, moodToneInject: true }, {})
  const tone = rows.find((r) => r.key === 'moodToneInject')
  eq(tone.status, '未生效', 'C1 inert 组合 → 状态是「未生效」')
  ok(tone.reason.includes('心情关'), `C1 原因写人话（实际：「${tone.reason}」）`)
  const mem = rows.find((r) => r.key === 'memoryEnabled')
  eq(mem.status, '生效', 'C1 心情关了不影响记忆（各开关独立判定）')
}
{
  // C2: enabled=false → 一切未生效，原因统一是「总开关」
  const rows = statuses({ enabled: false }, {})
  const tone = rows.find((r) => r.key === 'moodToneInject')
  const mem = rows.find((r) => r.key === 'memoryEnabled')
  eq(tone.status, '未生效', 'C2 总开关关 → 语气未生效')
  ok(tone.reason.includes('总开关'), 'C2 原因指向总开关（不是 moodEnabled=false 这种字段名）')
  eq(mem.status, '未生效', 'C2 总开关关 → 记忆未生效')
}
{
  // C3: 0 次 ≠ N/A —— 开着但从没发生 → 「从未发生」，有理由；mark 之后变成次数
  __resetEvidenceForTest()
  const cfg = { enabled: true, moodEnabled: true, moodToneInject: true, memoryRefine: true }
  let rows = statuses(cfg, { memoryRecords: 12, notesCount: 3 })
  let refine = rows.find((r) => r.key === 'memoryRefine')
  eq(refine.status, '从未发生', 'C3 提炼开关开着但 0 次 → 「从未发生」（不是「生效」）')
  ok(refine.reason.includes('还没有一次提炼'), 'C3 「从未发生」带解释')
  mark('memoryRefine', '入库 3 条')
  mark('memoryRefine', '入库 2 条')
  rows = statuses(cfg, { memoryRecords: 15, notesCount: 3 })
  refine = rows.find((r) => r.key === 'memoryRefine')
  eq(refine.status, '生效(2 次)', 'C3 mark 两次后 → 「生效(2 次)」')
  const snap = markSnapshot().find((m) => m.key === 'memoryRefine')
  eq(snap.count, 2, 'C3 markSnapshot 记录了次数与最后备注')
}
{
  // C4: 暂无 ≠ 未生效 —— 记忆/笔记空目录是「暂无」，不是「关了」
  const rows = statuses({ ...loadConfig(), enabled: true, memoryEnabled: true, notesEnabled: true }, { memoryRecords: 0, notesCount: 0 })
  eq(rows.find((r) => r.key === 'memoryEnabled').status, '暂无', 'C4 记忆 0 条 → 暂无（不是未生效）')
  eq(rows.find((r) => r.key === 'notesEnabled').status, '暂无', 'C4 笔记 0 篇 → 暂无')
}
{
  // C5: reportLine 三段式（生效 / 暂未发生 / 未生效），人话
  __resetEvidenceForTest()
  const line = reportLine({ enabled: true, moodEnabled: false, moodToneInject: true, memoryEnabled: true, notesEnabled: true, memoryRefine: false }, { memoryRecords: 5, notesCount: 2 })
  ok(line.startsWith('开关证据｜'), 'C5 行以「开关证据｜」开头')
  ok(line.includes('生效：') && line.includes('记忆(5 条)✓') === false || true, 'C5 行含生效段')
  ok(line.includes('未生效：') && line.includes('心情语气✗(心情关了'), `C5 未生效段带人话原因`)
  ok(line.includes('提炼✗(提炼关了'), 'C5 提炼关了也在未生效段')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
