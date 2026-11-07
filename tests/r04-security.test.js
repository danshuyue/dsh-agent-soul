/**
 * R04 · 安全收口（第三份报告 P1-S1…S4、P2-14）+ P1-D7/D8
 *
 * S1  GET /persona 绕过 cwd 归属校验，且返回全文
 * S2  normalizeCwdParam 接受 UNC 并直接 statSync（SMB 凭据外发 + 事件循环冻结）
 * S3  sec-fetch-site 值拼错（'samesite' ≠ 'same-site'），同站防线是死代码
 * S4  多处 handler 仍把 error.message 原文回给客户端（含绝对路径）
 * P2-14  POST /memory 的 edit 分支绕过脱敏
 * P1-D7  maintain 无视 projectMemoryEnabled
 * P1-D8  容量到顶且无可压缩项时 addRecord 照样 push
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r04-sec-'))
const outside = mkdtempSync(join(tmpdir(), 'soul-r04-out-'))
process.env.DSH_HOME = sandbox
process.env.DSH_SOUL_API_TOKEN = 'r04-security-token-padded-to-32-chars'
delete process.env.DSH_SOUL_ALLOW_REMOTE_API

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

writeFileSync(join(outside, 'AGENT.md'), 'R04_OUTSIDE_SECRET\n', 'utf8')
mkdirSync(join(sandbox, 'agents'), { recursive: true })

const { ensureDirs, __setAtomicWriteFailureForTest } = await imp('paths.js')
ensureDirs()
const { registerApi, API_PREFIX } = await imp('api.js')
const { normalizeCwdParam, isExistingDirectory } = await imp('http/sessions.js')
const { issueSessionToken } = await imp('core/api-token.js')
const { setFallbackCwd } = await imp('tool.js')
const memory = await imp('memory.js')
const store = await imp('store.js')

let handler = null
registerApi({ webServer: { register(spec) { handler = spec.handler; return () => {} } } })

function fakeReq(method, url, body, headers = {}) {
  const listeners = new Map()
  const req = {
    method, url,
    headers: { host: '127.0.0.1:53397', 'x-soul-token': process.env.DSH_SOUL_API_TOKEN, ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on(e, cb) { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(cb); return req },
    destroy() {}
  }
  process.nextTick(() => {
    const fire = (e, v) => (listeners.get(e) ?? []).forEach((cb) => cb(v))
    if (body !== undefined) fire('data', Buffer.from(JSON.stringify(body), 'utf8'))
    fire('end')
  })
  return req
}
function fakeRes() {
  const out = { status: 0, body: '' }
  return { writeHead(c) { out.status = c }, end(c) { if (c != null) out.body += String(c) }, result: out }
}
async function call(method, p, body) {
  const res = fakeRes()
  await handler(fakeReq(method, `${API_PREFIX}${p}`, body), res)
  let json = null
  try { json = JSON.parse(res.result.body) } catch { /* 非 JSON */ }
  return { status: res.result.status, json, raw: res.result.body }
}

// ---------------------------------------------------------------------------
console.log('S1 · GET /persona 必须过归属校验，且不返回未授权目录的全文')
// ---------------------------------------------------------------------------
{
  const denied = await call('GET', `/persona?kind=project&cwd=${encodeURIComponent(outside)}`)
  eq(denied.status, 400, '未登记目录 → 400')
  eq(denied.json?.cwdSource, 'rejected-unowned', 'cwdSource 说明是归属问题')
  ok(!String(denied.raw).includes('R04_OUTSIDE_SECRET'), '响应体里没有那个目录的正文')

  // 宿主给的目录 → 允许（模拟当前会话）。
  // 注意 GET /persona 读的是 DSH_HOME 里存的项目人格（storedProjectPersonaPath），
  // 不是 cwd 下的 AGENT.md —— 所以先用 POST 写一份，再读回来。
  setFallbackCwd(outside)
  const wrote = await call('POST', '/persona', { kind: 'project', cwd: outside, text: '# 项目\nR04_OUTSIDE_SECRET' })
  eq(wrote.status, 200, '授权目录可以先写入项目人格')
  const allowed = await call('GET', `/persona?kind=project&cwd=${encodeURIComponent(outside)}`)
  setFallbackCwd(sandbox)
  eq(allowed.status, 200, '宿主给的目录 → 200')
  ok(String(allowed.json?.text ?? '').includes('R04_OUTSIDE_SECRET'), '授权目录的正文可以读到')
}

// ---------------------------------------------------------------------------
console.log('S2 · UNC/设备路径在字符串阶段拒绝；未授权路径不碰磁盘')
// ---------------------------------------------------------------------------
{
  ok(normalizeCwdParam('\\\\attacker.com\\share') === null, 'UNC 拒绝')
  ok(normalizeCwdParam('\\\\?\\C:\\Windows') === null, '设备命名空间拒绝')
  ok(normalizeCwdParam('\\\\.\\PhysicalDrive0') === null, '设备路径拒绝')

  // 未归属 + 不存在：判成 rejected-unowned（说明归属是纯字符串判的，没 stat）
  const ghost = join(outside, 'no-such-subdir')
  const r1 = await call('GET', `/state?cwd=${encodeURIComponent(ghost)}`)
  eq(r1.json?.workspace?.cwdSource, 'rejected-unowned', '未归属的不存在路径 → rejected-unowned（没碰磁盘）')

  // 已归属 + 不存在：才走到存在性检查，判成 rejected
  const { registerProject } = await imp('core/registry.js')
  registerProject(ghost, {})
  const r2 = await call('GET', `/state?cwd=${encodeURIComponent(ghost)}`)
  eq(r2.json?.workspace?.cwdSource, 'rejected', '已登记但目录已不存在 → rejected（此时才 stat）')
  ok(isExistingDirectory(ghost) === false, 'isExistingDirectory 直接验证也不存在')
}

// ---------------------------------------------------------------------------
console.log('S3 · sec-fetch-site 用规范值（same-site 必拒、same-origin 放行）')
// ---------------------------------------------------------------------------
{
  // fixed 模式下 /session 不发放，所以这一段先把启动环境令牌摘掉
  const savedToken = process.env.DSH_SOUL_API_TOKEN
  delete process.env.DSH_SOUL_API_TOKEN
  try {
    const mk = (site) => ({ headers: { 'sec-fetch-site': site } })
    eq(issueSessionToken(mk('cross-site')).status, 403, 'cross-site → 403')
    eq(issueSessionToken(mk('same-site')).status, 403, 'same-site → 403（这条以前因为拼错而失效）')
    eq(issueSessionToken(mk('SAME-SITE')).status, 403, '大小写不敏感')
    const sameOrigin = issueSessionToken(mk('same-origin'))
    eq(sameOrigin.ok, true, 'same-origin → 发放')
    const none = issueSessionToken(mk('none'))
    eq(none.ok, true, 'none（地址栏直接打开）→ 发放')
  } finally {
    if (savedToken !== undefined) process.env.DSH_SOUL_API_TOKEN = savedToken
  }
}

// ---------------------------------------------------------------------------
console.log('S4 · 写盘失败对外固定文案，原因只进日志')
// ---------------------------------------------------------------------------
{
  __setAtomicWriteFailureForTest(() => ({ ok: false, error: `EPERM: rename '${sandbox}\\AGENT.md.tmp' -> '${sandbox}\\AGENT.md'` }))
  let res
  try {
    res = await call('POST', '/persona', { kind: 'global', text: '# 测试人格' })
  } finally {
    __setAtomicWriteFailureForTest(null)
  }
  eq(res.status, 500, '写盘失败 → 500')
  ok(String(res.json?.error ?? '').includes('写盘失败'), '文案仍然说是写盘失败（不丢语义）')
  ok(!String(res.raw).includes('AGENT.md.tmp'), '响应体里没有临时文件路径')
  ok(!String(res.raw).includes(sandbox), '响应体里没有 DSH_HOME 绝对路径')
  ok(/SOUL_[a-z0-9]+/i.test(String(res.json?.code ?? '')), '带追踪码，便于对日志')
}

// ---------------------------------------------------------------------------
console.log('P2-14 · 设置页 edit 也要脱敏')
// ---------------------------------------------------------------------------
{
  const cfg = store.loadConfig()
  const card = store.globalCard()
  const added = memory.addRecord(card, { text: '编辑脱敏测试：原始内容', source: 'manual' }, cfg, Date.now())
  const id = added.record?.id
  ok(typeof id === 'string' && id.length > 0, '先写入一条用于编辑')
  store.saveGlobalCard(card)

  const edited = await call('POST', '/memory', {
    scope: 'global', action: 'edit', id,
    text: '我的卡号 6222020200112233445 请不要存下来'
  })
  eq(edited.status, 200, 'edit 成功')
  const after = store.globalCard().records.find((r) => r.id === id)
  ok(after !== undefined, '记录还在')
  ok(!String(after?.text ?? '').includes('6222020200112233445'), '卡号被脱敏（不再原样落盘）')
  ok(String(after?.text ?? '').includes('请不要存下来') || String(after?.text ?? '') !== '', '正文其余部分保留')
}

// ---------------------------------------------------------------------------
console.log('D7 · 关掉项目记忆后 maintain 不碰项目卡')
// ---------------------------------------------------------------------------
{
  const { maintain } = await imp('state/maintain.js')
  const { projectMemoryPath } = await imp('paths.js')
  const cwd = outside
  const file = projectMemoryPath(cwd)
  mkdirSync(dirname(file), { recursive: true })
  const old = memory.createCard('project', Date.now() - 5 * 86400000)
  old.lastDecayDate = '2020-01-01'
  memory.addRecord(old, { text: '项目卡里的一条旧记忆', importance: 30 }, store.loadConfig(), Date.now() - 5 * 86400000)
  memory.saveCard(file, old)
  const before = statSync(file).mtimeMs

  await new Promise((r) => setTimeout(r, 30))
  const report = maintain(cwd, { ...store.loadConfig(), projectMemoryEnabled: false })
  const afterStat = existsSync(file) ? statSync(file).mtimeMs : 0
  eq(report.decayed.includes('project'), false, '报告里没有 project（没被处理）')
  eq(afterStat, before, '项目卡文件 mtime 未变')

  // 开关打开时应该会处理（证明上面不是"什么都没做"的假绿）
  await new Promise((r) => setTimeout(r, 30))
  const report2 = maintain(cwd, { ...store.loadConfig(), projectMemoryEnabled: true })
  ok(report2.decayed.includes('project') || statSync(file).mtimeMs !== before,
    '开关打开后项目卡被处理（对照组）')
}

// ---------------------------------------------------------------------------
console.log('D8 · 容量到顶且无可压缩项时拒绝写入')
// ---------------------------------------------------------------------------
{
  // normalizeConfig 会把 maxRecords 夹到 [20, 5000]，所以这里用 20 而不是 5
  const cfg = { ...store.loadConfig(), maxRecords: 20 }
  const card = memory.createCard('global', Date.now())
  for (let i = 0; i < 20; i += 1) {
    memory.addRecord(card, { text: `受保护记忆 ${i} 一条足够长的内容`, importance: 90, pinned: true }, cfg, Date.now())
  }
  eq(card.records.length, 20, '先塞满 20 条（全部 pinned）')
  const res = memory.addRecord(card, { text: '再写一条应该被拒绝的', importance: 90 }, cfg, Date.now())
  eq(res.ok, false, '满且无可压缩项 → 拒绝')
  ok(String(res.reason ?? '').includes('已满'), '拒绝原因说明是容量问题')
  eq(card.records.length, 20, '没有偷偷超过上限')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
rmSync(outside, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
