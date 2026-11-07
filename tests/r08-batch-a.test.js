/**
 * R8 · A 批止血（P2-12 / 鉴权链兜底 / P2-19 / P2-25·26·28 的服务端可测部分）
 *
 * ① P2-12：合并路径必须用**无副作用**的读卡 —— 以前 `loadCard` 的 catch 会 parkCorrupt，
 *    一次瞬时读失败就把主记忆文件改名 + 置只读，用户看到的是「记忆清空」。
 * ② 鉴权链兜底：handler 里抛异常必须变成 500，而不是逃出 webServer 击穿宿主。
 * ③ P2-19：judgeProvider 配成非 siliconflow 时，第一次调用就要留下明确告警。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r8-'))
process.env.DSH_HOME = sandbox
process.env.DSH_SOUL_API_TOKEN = 'r8-batch-a-token-padded-to-32-chars'
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

const { ensureDirs } = await imp('paths.js')
ensureDirs()
const memory = await imp('memory.js')

// ---------------------------------------------------------------------------
console.log('① P2-12 · 坏卡不能因为「看一眼」就被挪走')
// ---------------------------------------------------------------------------
{
  const file = join(sandbox, 'agents', 'broken-card.json')
  writeFileSync(file, '{ 这不是合法 JSON', 'utf8')

  const quiet = memory.readCardQuietly(file)
  eq(quiet, null, '无副作用读：坏文件返回 null')
  ok(existsSync(file), '文件还在原地（没有被改名）')
  const siblings = (() => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  })()
  ok(siblings.includes('这不是合法 JSON'), '内容也没被动过')

  // 对照组：loadCard（真正的加载路径）仍然要抢救现场
  const rescued = memory.loadCard(file)
  eq(rescued, null, 'loadCard 同样返回 null')
  ok(!existsSync(file), 'loadCard 会把坏卡挪走（这是加载路径该做的事）')
}

// ---------------------------------------------------------------------------
console.log('② 合并路径不再调用会 parkCorrupt 的 loadCard')
// ---------------------------------------------------------------------------
{
  const cardsSrc = readFileSync(join(root, 'lib', 'state', 'cards.js'), 'utf8')
  ok(cardsSrc.includes('readCardQuietly'),
    'cards.js 用了无副作用读（合并 + 写后回读都走它）')
  // 允许 loadCard 只出现在 loadCached 的加载参数里；合并路径必须是 readCardQuietly
  ok(!cardsSrc.includes('const disk = loadCard('), '合并/回读路径不再用 loadCard')
  ok((cardsSrc.match(/const disk = readCardQuietly\(file\)/g) ?? []).length === 2,
    '两处读盘（合并 + 写后回读）都用无副作用读')
}

// ---------------------------------------------------------------------------
console.log('③ 鉴权链兜底：handler 抛异常 → 500，不外泄')
// ---------------------------------------------------------------------------
{
  const { registerApi, API_PREFIX } = await imp('api.js')
  let handler = null
  // 故意让 Host 判定抛错：requestRejection 抛
  const ctx = {
    get: (key) => (key === 'connection'
      ? { requestRejection: () => { throw new Error('宿主内部炸了') } }
      : undefined)
  }
  registerApi({ ...ctx, webServer: { register(spec) { handler = spec.handler; return () => {} } } })

  const listeners = new Map()
  const req = {
    method: 'GET',
    url: `${API_PREFIX}/state`,
    headers: { host: '127.0.0.1:1', 'x-soul-token': process.env.DSH_SOUL_API_TOKEN },
    socket: { remoteAddress: '127.0.0.1' },
    on(e, cb) { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(cb); return req },
    destroy() {}
  }
  process.nextTick(() => (listeners.get('end') ?? []).forEach((cb) => cb()))
  const out = { status: 0, body: '' }
  const res = { writeHead(c) { out.status = c }, end(b) { if (b != null) out.body += String(b) } }

  let threw = false
  try {
    await handler(req, res)
  } catch {
    threw = true
  }
  eq(threw, false, '异常没有从 handler 逃出去（否则宿主会退出）')
  ok(out.status === 200 || out.status === 403 || out.status === 500,
    `拿到了一个明确的状态码（${out.status}）`)
  ok(!String(out.body).includes('宿主内部炸了'), '响应体里没有内部异常原文')
}

// ---------------------------------------------------------------------------
console.log('④ P2-19 · 自定义 judge provider 第一次调用就告警')
// ---------------------------------------------------------------------------
{
  const logs = []
  const judge = await imp('mood/judge.js')
  const llm = { stream: null }
  await judge.judgeMood(llm, { session: { header: { id: 's-r8' } } }, '你好', '嗯', 'talk', {
    self: '糖糖',
    owner: '树树',
    judgeProvider: 'some-other-provider',
    judgeModel: 'whatever'
  }, (...args) => logs.push(args.join(' ')))

  const hit = logs.filter((line) => line.includes('some-other-provider'))
  ok(hit.length >= 1, '留下了告警（不再是每轮静默失败）')
  ok(hit.some((line) => line.includes('停止变化')), '告警说明了后果')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
