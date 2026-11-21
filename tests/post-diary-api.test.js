/**
 * POST /diary API 全链路回归（2026-11-05；2026-11-21 / 0.10.0 改成摘录）：
 *   node tests/post-diary-api.test.js
 *
 * 2026-11-05 的版本验的是「handler → runDiaryOnce → composeDiaryText(llm.stream) →
 * writeDiaryFile」。0.10.0 起主流程不再自己调模型（写的人是绑定会话；兜底是规则化提取），
 * 所以这条链改成：handler → runDiaryOnce → 规则化兜底 → writeExcerptFile。
 * 仍然钉住：日期白名单（写面不能跳目录）、令牌鉴权、开关、写盘失败必须 500。
 * 全程临时 DSH_HOME，数据自造，不碰真实 ~/.dsh。
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-post-diary-'))
process.env.DSH_HOME = HOME
process.env.DSH_SOUL_API_TOKEN = 'soul-post-diary-test-token-padded-to-32-'
delete process.env.DSH_SOUL_ALLOW_REMOTE_API

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

const paths = await import('../lib/paths.js')
const store = await import('../lib/store.js')
const diary = await import('../lib/diary.js')
const { registerApi, API_PREFIX } = await import('../lib/api.js')

paths.ensureDirs()
store.saveConfig({
  diaryEnabled: true,
  // 不投递给 agent，直接走规则化兜底，省掉宿主 agents/sessions 服务
  diaryAgentWrite: false,
  diaryOverwrite: true,
  moodEnabled: false
})

// 假宿主：llm.stream 一次都不该被调用（0.10.0 的兜底不调模型）
const llmCalls = []
const ctx = {
  llm: {
    stream: async function* (params) {
      llmCalls.push(params)
      throw new Error('摘录主流程不该直接调模型')
    }
  },
  webServer: {
    register: (spec) => { handler = spec.handler; return () => {} }
  }
}
let handler = null
registerApi(ctx)
ok(typeof handler === 'function', 'API 路由注册成功')

function fakeReq(method, url, body, withToken = true) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: {
      host: '127.0.0.1:53397',
      ...(withToken ? { 'x-soul-token': process.env.DSH_SOUL_API_TOKEN } : {})
    },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(cb)
      return req
    },
    destroy() {}
  }
  process.nextTick(() => {
    const fire = (event, value) => (listeners.get(event) ?? []).forEach((cb) => cb(value))
    if (body !== undefined) fire('data', Buffer.from(JSON.stringify(body), 'utf8'))
    fire('end')
  })
  return req
}
function fakeRes() {
  const out = { status: 0, body: '' }
  return {
    writeHead(code) { out.status = code },
    end(chunk) { if (chunk !== undefined && chunk !== null) out.body += String(chunk) },
    result: out
  }
}
const call = async (method, path, body, withToken = true) => {
  const res = fakeRes()
  await handler(fakeReq(method, `${API_PREFIX}${path}`, body, withToken), res)
  let payload = {}
  try { payload = JSON.parse(res.result.body || '{}') } catch { /* 非 JSON 当空 */ }
  return { status: res.result.status, payload, raw: res.result.body }
}

// ---------------------------------------------------------------------------
console.log('\n① 正常全链路：HTTP → 规则化兜底 → 一篇摘录落盘（不调模型）')
const date = '2026-11-05'
// 造一段当天的对话流水：兜底就是从这里提取「谁说了什么」
mkdirSync(join(HOME, 'agents', 'diary', 'conversations'), { recursive: true })
writeFileSync(paths.diaryJsonlPath(date), [
  JSON.stringify({ t: new Date(2026, 10, 5, 10, 0, 0).getTime(), role: 'user', text: '今天把日记改成摘录了。后面还有话' }),
  JSON.stringify({ t: new Date(2026, 10, 5, 10, 5, 0).getTime(), role: 'assistant', text: '好，我记下来。' })
].join('\n') + '\n', 'utf8')

const normal = await call('POST', '/diary', { date, note: '手动触发的备注' })
eq(normal.status, 200, '合法 date → 200（不是 500 / 不是超时）')
eq(normal.payload.ok, true, '响应体 ok:true')
eq(normal.payload.date, date, '响应体回显请求的日期')
eq(llmCalls.length, 0, '宿主 llm.stream 一次都没被调用（兜底是规则化提取）')

const excerptFile = paths.diaryExcerptPath(date)
ok(existsSync(excerptFile), '摘录文件已落盘')
const excerptText = existsSync(excerptFile) ? readFileSync(excerptFile, 'utf8') : ''
ok(excerptText.startsWith(`# ${date}`), '首行是「# 日期」')
ok(excerptText.includes('今天把日记改成摘录了'), '正文来自对话流水')
ok(excerptText.includes('手动触发的备注'), '手动备注也进了摘录（没有被静默丢掉）')
ok(existsSync(paths.diaryLegacyPath('public', date)) === false, '没有往旧的 public/ 写任何东西')

// ---------------------------------------------------------------------------
console.log('\n② 写面穿越：API 层必须挡在落盘之前')
const persona = join(paths.agentsDir(), 'AGENT.md')
writeFileSync(persona, '人格原文-不要被覆盖', 'utf8')
const attack = await call('POST', '/diary', { date: '../../../AGENT', note: '恶意' })
eq(attack.status, 400, 'date=../../../AGENT → 400')
ok(String(attack.payload.error ?? '').includes('date'), '错误信息指明是 date 参数')
const privateHop = await call('POST', '/diary', { date: '../private/2026-11-02', note: '恶意' })
eq(privateHop.status, 400, 'date=../private/日期 → 400（写面同样不能跳目录）')
eq(readFileSync(persona, 'utf8'), '人格原文-不要被覆盖', '人格文件一字未动')

// ---------------------------------------------------------------------------
console.log('\n③ 鉴权与开关：')
const noToken = await call('POST', '/diary', { date: '2026-11-04' }, false)
eq(noToken.status, 401, '不带令牌 → 401（这条路由同样受 S2 鉴权保护）')
eq(existsSync(paths.diaryExcerptPath('2026-11-04')), false, '401 请求没有落盘')

store.saveConfig({ diaryEnabled: false })
const disabled = await call('POST', '/diary', { date: '2026-11-03' })
eq(disabled.status, 403, '摘录功能关闭 → 403')
eq(existsSync(paths.diaryExcerptPath('2026-11-03')), false, '关闭时没有落盘')
store.saveConfig({ diaryEnabled: true })

// ---------------------------------------------------------------------------
console.log('\n④ 写盘失败时 API 必须回 500 而不是假装成功')
paths.__setAtomicWriteFailureForTest(() => ({ ok: false, error: '测试注入的写盘失败' }))
diary.__resetDiaryInFlightForTest()
const failDate = '2026-11-01'
const failedWrite = await call('POST', '/diary', { date: failDate })
paths.__setAtomicWriteFailureForTest(null)
eq(failedWrite.status, 500, '写盘失败 → 500')
eq(failedWrite.payload.ok, false, '响应体 ok:false，调用方可以重试')
eq(existsSync(paths.diaryExcerptPath(failDate)), false, '失败路径没有写出半截摘录')

// ---------------------------------------------------------------------------
console.log('\n⑤ GET /diary/list、/diary/read：只有摘录，旧日记不再出现（2026-11-21 / 0.10.5）')
// 造一份 0.10.0 之前的旧日记（public/ + private/）：文件在，但设置页不该再显示
mkdirSync(join(HOME, 'agents', 'diary', 'public'), { recursive: true })
mkdirSync(join(HOME, 'agents', 'diary', 'private'), { recursive: true })
writeFileSync(paths.diaryLegacyPath('public', '2026-11-10'), '【公开】\n2026-11-10\n\n旧日记正文\n', 'utf8')
writeFileSync(paths.diaryLegacyPath('private', '2026-11-10'), '【私密】\n2026-11-10\n\n旧私密正文\n', 'utf8')

const list = await call('GET', '/diary/list?days=30')
eq(list.status, 200, 'GET /diary/list → 200')
const row = (list.payload.list ?? []).find((item) => item.date === date)
ok(row !== undefined && row.hasExcerpt === true, '列表里那天的 hasExcerpt=true')
ok(
  (list.payload.list ?? []).every((item) => item.legacy === undefined),
  '列表里没有任何 legacy 标记（旧日记不显示）'
)
ok(
  (list.payload.list ?? []).every((item) => item.date !== '2026-11-10'),
  '只有旧日记的那天不出现在列表里'
)

const read = await call('GET', `/diary/read?date=${date}`)
eq(read.status, 200, 'GET /diary/read → 200')
eq(read.payload.hasExcerpt, true, 'read 返回 hasExcerpt')
ok(String(read.payload.excerptContent ?? '').includes('今天把日记改成摘录了'), 'read 返回摘录全文')
ok(Array.isArray(read.payload.excerptLines) && read.payload.excerptLines.length > 0, 'read 同时给出条目数组')
ok(read.payload.legacy === undefined, 'read 不再返回 legacy 字段')

const readLegacy = await call('GET', '/diary/read?date=2026-11-10')
eq(readLegacy.status, 200, '旧日记那天也能读（不报错）')
eq(readLegacy.payload.hasExcerpt, false, '旧日记不算摘录')
ok(readLegacy.payload.legacy === undefined, '不再回 legacy 字段')
ok(!JSON.stringify(readLegacy.payload).includes('旧日记正文'), '旧公开篇正文不再出接口')
ok(!JSON.stringify(readLegacy.payload).includes('旧私密正文'), '旧私密篇正文也不出接口')

const badRead = await call('GET', '/diary/read?date=../AGENT')
eq(badRead.status, 400, 'read 的 date 也过白名单')

console.log(`\n结果：${passed} 过 / ${failed} 败`)
rmSync(HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
