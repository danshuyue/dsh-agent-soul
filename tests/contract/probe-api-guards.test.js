/**
 * 契约回归 · API 与日记边界（2026-11-06 P10 从 _review-tmp 探针固化）
 *
 * 原探针只是「打印结论」的验证脚本，写在 _review-tmp/ 里、路径硬编码到审查副本，
 * 换台机器就没了，而且修复被回退时它不会失败。这里改成真断言：
 * 任何一条守卫失效，本文件退出码非 0，npm test 立刻红。
 *
 * 覆盖：P0-1（回环边界不可被 HTTP 放宽）、P0-2（日期白名单 / 私密日记读穿 /
 * 写面覆盖人格文件）、P0-3（配置归一不丢键 + 项目记忆开关生效）。
 * 全程自造数据 + 临时 DSH_HOME，绝不读写真实 ~/.dsh。
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'soul-probe-api-'))
process.env.DSH_HOME = HOME
delete process.env.DSH_SOUL_ALLOW_REMOTE_API
// S2 起接口要带会话令牌；固定令牌模式，避免把 401 误判成「漏洞已堵」。
process.env.DSH_SOUL_API_TOKEN = 'soul-probe-api-fixed-token-padded-to-32-'

const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

const PERSONA = 'ORIGINAL_PERSONA_FILE_DO_NOT_LEAK'
const PRIVATE = 'PRIVATE_SECRET_POC_这是私密日记正文'
const PUBLIC = 'PUBLIC_ONLY_POC'

try {
  mkdirSync(join(HOME, 'agents', 'diary', 'public'), { recursive: true })
  mkdirSync(join(HOME, 'agents', 'diary', 'private'), { recursive: true })
  writeFileSync(join(HOME, 'AGENT.md'), PERSONA, 'utf8')
  writeFileSync(join(HOME, 'agents', 'diary', 'private', '2026-11-02.md'), PRIVATE, 'utf8')
  writeFileSync(join(HOME, 'agents', 'diary', 'public', '2026-11-02.md'), PUBLIC, 'utf8')

  const api = await imp('api.js')
  const store = await imp('store.js')
  const { normalizeConfig } = await imp('memory.js')
  const { diaryPublicPath, diaryPrivatePath } = await imp('paths.js')
  const { writeDiaryFile } = await imp('diary.js')

  let handler = null
  api.registerApi({ webServer: { register: (opt) => { handler = opt.handler; return () => {} } } })
  ok(typeof handler === 'function', 'API handler 注册成功')

  function call(method, url, body, remoteAddress = '127.0.0.1') {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:3000', 'x-soul-token': process.env.DSH_SOUL_API_TOKEN }
    req.socket = { remoteAddress }
    req.destroy = () => {}
    const res = { code: 0, text: '', writeHead(c) { this.code = c }, end(s) { this.text = String(s) } }
    const done = Promise.resolve(handler(req, res))
      .then(() => res)
      .catch((e) => { res.code = -1; res.text = String(e); return res })
    if (body !== undefined) queueMicrotask(() => { req.emit('data', Buffer.from(body)); req.emit('end') })
    return done
  }

  console.log('\n① 日期白名单（P0-2）')
  for (const [label, fn, arg] of [
    ['diaryPublicPath("../private/2026-11-02")', diaryPublicPath, '../private/2026-11-02'],
    ['diaryPublicPath("../../../AGENT")', diaryPublicPath, '../../../AGENT'],
    ['diaryPrivatePath("../public/2026-11-02")', diaryPrivatePath, '../public/2026-11-02']
  ]) {
    let threw = false
    try { fn(arg) } catch { threw = true }
    ok(threw, `${label} 被路径层断言拒绝`)
  }
  ok(diaryPublicPath('2026-11-02').endsWith('2026-11-02.md'), '合法日期仍能正常拼路径（白名单不误伤）')

  console.log('\n② /diary/read 不能读穿私密日记与任意 .md')
  const rPrivate = await call('GET', '/api/soul/diary/private?date=2026-11-02')
  eq(rPrivate.code, 403, '/diary/private 默认 403（默认 diaryPrivateVisible=false）')
  ok(!String(rPrivate.text).includes('PRIVATE_SECRET_POC'), '默认门不回显私密正文')

  const opened = api.privateDiaryView(
    { url: '/api/soul/diary/private?date=2026-11-02', socket: { remoteAddress: '127.0.0.1' } },
    { diaryPrivateVisible: true }
  )
  eq(opened.status, 200, '显式打开开关后 /diary/private 这道门本身可用')
  ok(String(opened.payload?.content).includes('PRIVATE_SECRET_POC'), '开关打开时确实能读到私密正文（门有效）')

  const rBypass = await call('GET', '/api/soul/diary/read?date=' + encodeURIComponent('../private/2026-11-02'))
  eq(rBypass.code, 400, '★ /diary/read 用 ../private/日期 绕过开关 → 400')
  ok(!String(rBypass.text).includes('PRIVATE_SECRET_POC'), '★ 响应里没有私密日记正文')
  const rEscape = await call('GET', '/api/soul/diary/read?date=' + encodeURIComponent('../../../AGENT'))
  eq(rEscape.code, 400, '/diary/read 读任意 .md → 400')
  ok(!String(rEscape.text).includes(PERSONA), '响应里没有 AGENT.md 原文')
  const rValid = await call('GET', '/api/soul/diary/read?date=2026-11-02')
  eq(rValid.code, 200, '合法日期的公开日记仍可读')
  ok(String(rValid.text).includes(PUBLIC), '合法读取能拿到公开正文')

  console.log('\n③ 写面：不能覆盖人格文件 / 任意位置新建 .md')
  eq(writeDiaryFile('public', '../../../AGENT', 'POC 覆盖了人格'), false, '非法日期写日记返回 false')
  ok(readFileSync(join(HOME, 'AGENT.md'), 'utf8').includes(PERSONA), 'AGENT.md 原文未被覆盖')
  eq(writeDiaryFile('public', '../../../poc-new-note', '任意路径新建'), false, '任意位置新建 .md 被拒绝')
  ok(!existsSync(join(HOME, 'poc-new-note.md')), '没有越界文件被创建')
  eq(writeDiaryFile('public', '2026-11-03', '合法的另一天'), true, '合法日期可以正常写（白名单不误伤写面）')

  console.log('\n④ /config 不能通过 HTTP 放宽回环边界（P0-1 止血）')
  store.saveConfig({ apiLoopbackOnly: true })
  const rConfig = await call('POST', '/api/soul/config', JSON.stringify({ apiLoopbackOnly: false }))
  eq(rConfig.code, 400, 'POST /config 关闭回环限制 → 400')
  eq(store.loadConfig().apiLoopbackOnly, true, '配置仍为 true（没被写进去）')
  ok(!api.shouldAllowApiRequest({ socket: { remoteAddress: '192.168.1.100' } }, store.loadConfig()), '非回环来源仍被拒绝')
  process.env.DSH_SOUL_ALLOW_REMOTE_API = '1'
  const rRelax = await call('POST', '/api/soul/config', JSON.stringify({ apiLoopbackOnly: false }))
  eq(rRelax.code, 200, '启动环境显式授权后逃生口可用')
  eq(store.loadConfig().apiLoopbackOnly, false, '显式授权确实放宽了边界')
  delete process.env.DSH_SOUL_ALLOW_REMOTE_API
  store.saveConfig({ apiLoopbackOnly: true })
  ok(!api.shouldAllowApiRequest({ socket: { remoteAddress: '192.168.1.100' } }, store.loadConfig()), '恢复默认后非回环仍被拒绝')

  console.log('\n⑤ 配置归一不丢键（P0-3）')
  const normalized = normalizeConfig(store.DEFAULT_CONFIG)
  const lost = Object.keys(store.DEFAULT_CONFIG).filter((k) => !(k in normalized))
  eq(lost, [], `DEFAULT_CONFIG 的 ${Object.keys(store.DEFAULT_CONFIG).length} 个键全部透传`)
  for (const k of ['purposeEnabled', 'projectMemoryEnabled', 'globalPromoteImportance']) {
    ok(normalized[k] === store.DEFAULT_CONFIG[k], `${k} 归一后值不变`)
  }
  const scopes = store.cardsFor('D:/tmp/demo-proj', { ...store.DEFAULT_CONFIG, projectMemoryEnabled: false }).map((c) => c.scope)
  eq(scopes, ['global'], '关闭项目记忆后 cardsFor 只返回 global 卡')
} catch (error) {
  failed += 1
  console.error(`  ✗ 探针执行抛异常：${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
} finally {
  delete process.env.DSH_SOUL_ALLOW_REMOTE_API
  delete process.env.DSH_SOUL_API_TOKEN
  rmSync(HOME, { recursive: true, force: true })
  console.log('\n收尾：')
  ok(!existsSync(HOME), '临时 DSH_HOME 已清理')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
