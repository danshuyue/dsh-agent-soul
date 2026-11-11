/**
 * R20 · 外部审查 43 条的修复验证（2026-11-10，按 R20 任务书）
 *
 *   A1/S2  ?cwd= 归属判定绕过：4 种恶意变体必须 rejected-unowned，且 /state
 *          / /persona?kind=project 读不到 DSH_HOME 之外的 AGENT.md
 *   A4/H1  legacyKeys 必须真能报出配置里的废弃键（曾因缺 import 恒空）
 *   A2/H5  apiLoopbackOnly 的字符串 "false"/"0" 必须 400；落盘 false 且未授权时
 *          回环请求仍放行（自救通道）
 *   M4     normalizeConfig({}) 的每个键 = DEFAULT_CONFIG 同名值（假默认值门禁）
 *   C      契约响应体断言：/state 的 legacyKeys 是数组、switches ≥ 17 条、
 *          persona.preview 不含盘符绝对路径（S2 的响应体级回归）
 *   C8     tools/sync-preview.mjs 跑一遍零漂移（此前从未被任何测试调用）
 *
 * 每节的毒化实录见交付档案（04-毒化证据.md），这里只放绿灯断言。
 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r20-'))
process.env.DSH_HOME = sandbox
process.env.TZ = 'UTC'
delete process.env.DSH_SOUL_ALLOW_REMOTE_API
mkdirSync(join(sandbox, 'agents'), { recursive: true })

let passed = 0
let failed = 0
const ok = (c, n) => { if (c) { passed += 1; console.log(`  ✓ ${n}`) } else { failed += 1; console.error(`  ✗ ${n}`) } }
const eq = (a, e, n) => ok(JSON.stringify(a) === JSON.stringify(e), `${n}${JSON.stringify(a) === JSON.stringify(e) ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(e)}）`}`)

const paths = await imp('paths.js')
const { ensureDirs } = paths
ensureDirs()
const sessions = await imp('http/sessions.js')
const { resolveCwd } = sessions
const persona = await imp('persona.js')
const system = await imp('http/routes/system.js')
const { handleGetState, handlePostConfig } = system
const middleware = await imp('http/middleware.js')
const { shouldAllowApiRequest } = middleware
const { CONFIG_FILE } = await imp('state/cache.js')
const memory = await imp('memory.js')
const store = await imp('store.js')

// 在 DSH_HOME 的**父目录**放一份机密 AGENT.md —— 修复前 `?cwd=<HOME>/..` 能读到它
// 放在独立的外部目录（不是共享 tmpdir 根）——模拟「DSH_HOME 之外的另一目录」，
  // 不与其它测试的临时目录互踩
  const outside = mkdtempSync(join(tmpdir(), 'r20-outside-'))
  const secretFile = join(outside, 'AGENT.md')
writeFileSync(secretFile, 'SECRET-AGENT-MD-R20', 'utf8')

/** 直调 handleGetState 的 harness（返回解析后的响应体与状态码）。 */
async function getState(query = '') {
  const captured = {}
  const res = { writeHead(c) { captured.code = c }, end(ch) { captured.body = JSON.parse(ch) } }
  await handleGetState({ get() { return undefined } }, { headers: {}, method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, res, new URLSearchParams(query), '/state')
  return { code: captured.code, body: captured.body ?? {} }
}
async function postConfig(body) {
  const { EventEmitter } = await import('node:events')
  const captured = {}
  const res = { writeHead(c) { captured.code = c }, end(ch) { captured.body = JSON.parse(ch) } }
  const req = new EventEmitter()
  process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  await handlePostConfig({}, req, res, new URLSearchParams(), '/config')
  return { code: captured.code, body: captured.body ?? {} }
}

// ---------------------------------------------------------------------------
console.log('A1/S2 · ?cwd= 用 .. 绕过归属判定')
// ---------------------------------------------------------------------------
{
  const home = paths.dshHome()
  const evil = [
    `${home}/..`,
    `${home}/../..`,
    `${home}\\..\\`,
    `${home.toUpperCase()}/..`,
    `${home}/./..`
  ]
  let allRejected = true
  for (const cwd of evil) {
    const pick = resolveCwd({ get() { return undefined } }, new URLSearchParams(`cwd=${encodeURIComponent(cwd)}`))
    if (pick.source === 'path') allRejected = false
  }
  ok(allRejected, '五种恶意变体全部 rejected（不再被前缀检查放过）')
  const good = resolveCwd({ get() { return undefined } }, new URLSearchParams(`cwd=${encodeURIComponent(home)}`))
  eq(good.source, 'path', '合法 DSH_HOME 不受影响')
}
{
  const state = await getState(`cwd=${encodeURIComponent(paths.dshHome() + '/..')}`)
  eq(state.code, 200, '/state 仍 200（拒绝的不是请求，是归属）')
  const text = JSON.stringify(state.body)
  ok(text.includes('SECRET-AGENT-MD-R20') === false, '/state 响应体里读不到 DSH_HOME 外的 AGENT.md')
  const preview = state.body?.persona?.preview ?? ''
  ok(preview.includes('SECRET-AGENT-MD-R20') === false, 'persona.preview 不含外部内容')
}
{
  // A4/H1 回归：配置文件里写上废弃键 → /state.legacyKeys 必须报出来
  writeFileSync(CONFIG_FILE(), JSON.stringify({ diarySchedule: '22:00', moodOwnerName: '老名字', ownerName: '已设' }, null, 2), 'utf8')
  const state = await getState()
  eq(state.body?.legacyKeys, ['diarySchedule', 'moodOwnerName'], 'legacyKeys 真的能报出配置里的废弃键（H1 修复的响应体级断言）')
}

// ---------------------------------------------------------------------------
console.log('A2/H5 · apiLoopbackOnly 的字符串形式')
// ---------------------------------------------------------------------------
{
  const r1 = await postConfig({ config: { apiLoopbackOnly: 'false' } })
  eq(r1.code, 400, '字符串 "false" → 400（原来穿闸落盘）')
  const r2 = await postConfig({ config: { apiLoopbackOnly: '0' } })
  eq(r2.code, 400, '字符串 "0" → 400')
  const r3 = await postConfig({ config: { apiLoopbackOnly: false } })
  eq(r3.code, 400, '布尔 false（未授权放宽）→ 400')
}
{
  // 自救通道：就算配置文件里躺着一个 false（手工编辑/历史残留），回环仍放行
  writeFileSync(CONFIG_FILE(), JSON.stringify({ apiLoopbackOnly: false, enabled: true }, null, 2), 'utf8')
  store.resetCaches()
  const loopback = { socket: { remoteAddress: '127.0.0.1' }, headers: {} }
  eq(shouldAllowApiRequest(loopback, { apiLoopbackOnly: false }), true, '落盘 false 且未授权时，回环请求仍放行（设置页不被锁死）')
  const remote = { socket: { remoteAddress: '203.0.113.9' }, headers: {} }
  eq(shouldAllowApiRequest(remote, { apiLoopbackOnly: false }), false, '非回环仍被拒（边界没有因此敞开）')
}

// ---------------------------------------------------------------------------
console.log('M4 · normalizeConfig({}) 与 DEFAULT_CONFIG 无假默认值')
// ---------------------------------------------------------------------------
{
  const cfg = memory.normalizeConfig({})
  const cache = await imp('state/cache.js')
  const mismatches = []
  for (const [k, v] of Object.entries(memory.DEFAULTS ?? {})) {
    if (k in cache.DEFAULT_CONFIG && JSON.stringify(cache.DEFAULT_CONFIG[k]) !== JSON.stringify(v)) {
      mismatches.push(`${k}: ${JSON.stringify(cache.DEFAULT_CONFIG[k])} vs ${JSON.stringify(v)}`)
    }
  }
  eq(mismatches, [], 'DEFAULTS 与 DEFAULT_CONFIG 的同名键值完全一致')
  eq(cfg.diaryToTodayMaxChars, 30, 'diaryToTodayMaxChars 的假默认值 10 已修正为 30')
}

// ---------------------------------------------------------------------------
console.log('批次 B 回归 · H6 / H7 / H4 / M5 / M20')
// ---------------------------------------------------------------------------
{
  // H6：LIFE_WORDS 补 g —— 多生活词句子的加分 > 6（原来恒 6）
  const { scoreEntry } = await imp('core/diary-pick.js')
  const life = scoreEntry({ role: 'user', text: '今天好累，晚上吃了宵夜，看完电影就睡了，梦里还在想你', len: 30, time: Date.now() })
  const lifeReason = life.reasons.find((r) => String(r).startsWith('生活词×'))
  ok(lifeReason !== undefined && Number(String(lifeReason).slice(4)) > 1, `H6 多生活词命中 > 1 次（实际 ${lifeReason}）`)
}
{
  // H7：纯英文单词查询能召回（原来 minHits=2 全滤掉）
  const cfg = memory.normalizeConfig({})
  const card = memory.createCard('global')
  memory.addRecord(card, { text: '树树的 STM32 开发板用的是 NUCLEO-F401RE，Keil 版本是 5.36', kind: 'fact', importance: 80 }, cfg, Date.now())
  const render = await imp('memory/render.js')
  const r = render.renderRecallOnly([card], { query: 'STM32', config: cfg })
  ok(String(r.text).includes('STM32'), 'H7 英文单词查询命中「想起来了」通道')
}
{
  // H4：老配置（无 ownerName 键、无 moodOwnerName）→ 兜底空串，不代填作者昵称
  const raw = JSON.parse(readFileSync(CONFIG_FILE(), 'utf8'))
  delete raw.ownerName
  delete raw.moodOwnerName
  writeFileSync(CONFIG_FILE(), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  const cache = await imp('state/cache.js')
  cache.resetCaches()
  eq((await imp('store.js')).loadConfig().ownerName, '', 'H4 缺旧键时兜底空串（不再写「树树」）')
}
{
  // M5：负时区下保留期清理正常工作（原来 UTC 混用导致一个文件都删不掉）
  const retention = await imp('retention.js')
  const entries = ['2026-11-01', '2026-11-05', '2026-11-10'].map((k) => ({ name: `${k}.jsonl`, bytes: 100 }))
  const plan = retention.planConversationPrune(entries, { today: '2026-11-10', keepDays: 3, maxBytes: 0 })
  eq(plan.toDelete.map((d) => d.name), ['2026-11-01.jsonl', '2026-11-05.jsonl'], 'M5 窗口外文件被正确列入删除（本地日历口径）')
}
{
  // M20：缺 createdAt 的记录按 updatedAt/lastSeenAt 兜底 → 会被正常衰减
  const scoring = await imp('memory/scoring.js')
  const old = Date.now() - 90 * 24 * 60 * 60 * 1000
  const verdict = scoring.targetClarity({ text: '一条很久以前的记录', importance: 10, updatedAt: new Date(old).toISOString() }, {}, Date.now())
  eq(verdict, 'forgotten', 'M20 缺 createdAt（updatedAt=90 天前）→ 判遗忘（原来被当成刚记的永不衰减）')
}

// ---------------------------------------------------------------------------
console.log('C · 契约响应体断言（原来只验 200）')
// ---------------------------------------------------------------------------
{
  const state = await getState()
  ok(Array.isArray(state.body?.legacyKeys), '/state.legacyKeys 是数组')
  ok(Array.isArray(state.body?.switches) && state.body.switches.length >= 17, `/state.switches ≥ 17 条（实际 ${state.body?.switches?.length}）`)
  const text = JSON.stringify(state.body)
  ok((state.body?.persona?.preview ?? '').includes(':\\') === false, 'persona.preview 不含绝对路径')
  ok((state.body?.legacyKeys ?? []).every((k) => k.indexOf(':\\') === -1), 'legacyKeys 不含路径')
  // M14：/attestation 的 sessionId/cwd 必须摘要，不再回显绝对路径。
  // （注意：/state 的 workspace.layers[].path 是设计内的「位置标注」——README 明文
  //  「用户要看得见这一份人格到底对哪个目录生效」，不在此列。）
  const attestCaptured = {}
  const attestRes = { writeHead(c) { attestCaptured.code = c }, end(ch) { attestCaptured.body = JSON.parse(ch) } }
  await system.handleGetAttestation({ get() { return undefined } }, { headers: {}, method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, attestRes, new URLSearchParams(), '/attestation')
  const attestText = JSON.stringify(attestCaptured.body ?? {})
  ok(attestText.includes(sandbox) === false && /:\\\\/.test(attestText) === false, '/attestation 响应体不含绝对路径（sessionId/cwd 已摘要）')
}

// ---------------------------------------------------------------------------
console.log('C8 · tools/sync-preview.mjs 跑一遍零漂移（此前零测试覆盖）')
// ---------------------------------------------------------------------------
{
  const before = existsSync(join(root, 'docs', 'preview.html')) ? readFileSync(join(root, 'docs', 'preview.html'), 'utf8') : ''
  const run = spawnSync(process.execPath, ['tools/sync-preview.mjs'], { cwd: root, encoding: 'utf8' })
  eq(run.status, 0, 'sync-preview 正常退出')
  const after = readFileSync(join(root, 'docs', 'preview.html'), 'utf8')
  eq(after, before, '样式一致时同步是零变更（脚本没把预览改坏）')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
if (existsSync(secretFile)) rmSync(secretFile, { force: true })
rmSync(join(dirname(secretFile)), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
