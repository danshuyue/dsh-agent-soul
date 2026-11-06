/**
 * POST /diary API 全链路回归（2026-11-05）：node tests/post-diary-api.test.js
 *
 * 报告 11.6 第 3 项：此前写面穿越只验到 `writeDiaryFile` 层 + API 400，
 * 没有把宿主 `llm` 注入、真正从 HTTP handler 一路跑到落盘。这里补齐这条链：
 *   handler → runDiaryOnce → composeDiaryText(llm.stream) → writeDiaryFile
 * 并同时钉住 P0-2 的隐私语义（公开的看不到私密）、S1 的日期白名单、
 * S2 的令牌鉴权。全程临时 DSH_HOME，数据自造，不碰真实 ~/.dsh。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // 不投递给 agent，直接走插件兜底生成，省掉宿主 agents/sessions 服务
  diaryAgentWrite: false,
  diarySummarizeProvider: 'fake-provider',
  diarySummarizeModel: 'fake-model',
  diarySummarizeTimeoutMs: 3000,
  diaryOverwrite: true,
  moodEnabled: false
})

// 假宿主：llm.stream 按 system 里的「私密」区分两篇，能验证正文流向。
const llmCalls = []
const ctx = {
  llm: {
    stream: async function* (params) {
      llmCalls.push(params)
      const text = String(params.system ?? '').includes('私密')
        ? '【私密】\n2026-11-05\n今天有点累，有些话只写给自己。'
        : '【公开】\n2026-11-05\n今天过得平静。'
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
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
console.log('\n① 正常全链路：HTTP → 宿主 llm → 两篇落盘')
const date = '2026-11-05'
const normal = await call('POST', '/diary', { date, note: '手动触发的备注' })
eq(normal.status, 200, '合法 date → 200（不是 500 / 不是超时）')
eq(normal.payload.ok, true, '响应体 ok:true')
eq(normal.payload.date, date, '响应体回显请求的日期')
eq(llmCalls.length, 2, '宿主 llm.stream 被调用两次（公开 + 私密）')

const publicFile = paths.diaryPublicPath(date)
const privateFile = paths.diaryPrivatePath(date)
ok(existsSync(publicFile), '公开日记文件已落盘')
ok(existsSync(privateFile), '私密日记文件已落盘')
const publicText = existsSync(publicFile) ? readFileSync(publicFile, 'utf8') : ''
const privateText = existsSync(privateFile) ? readFileSync(privateFile, 'utf8') : ''
ok(publicText.includes('今天过得平静'), '公开篇正文来自宿主 llm 的公开分支')
ok(privateText.includes('只写给自己'), '私密篇正文来自宿主 llm 的私密分支')
ok(publicText.includes('只写给自己') === false, '私密正文没有混进公开篇（P0-2 的隐私隔离链）')
ok(llmCalls.some((p) => String(p.messages?.[0]?.content?.[0]?.text ?? '').includes('手动触发的备注')), '手动备注进了生成提示')

// ---------------------------------------------------------------------------
console.log('\n② 写面穿越：API 层必须挡在宿主 llm 之前')
const callsBefore = llmCalls.length
const personaCandidates = [join(paths.agentsDir(), 'AGENT.md'), join(HOME, 'AGENT.md')]
writeFileSync(personaCandidates[0], '人格原文-不要被覆盖', 'utf8')
const attack = await call('POST', '/diary', { date: '../../../AGENT', note: '恶意' })
eq(attack.status, 400, 'date=../../../AGENT → 400')
ok(String(attack.payload.error ?? '').includes('date'), '错误信息指明是 date 参数')
const privateHop = await call('POST', '/diary', { date: '../private/2026-11-02', note: '恶意' })
eq(privateHop.status, 400, 'date=../private/日期 → 400（写面同样不能跳目录）')
eq(llmCalls.length, callsBefore, '被拒的请求没有进入日记主流程（llm 未被调用）')
eq(readFileSync(personaCandidates[0], 'utf8'), '人格原文-不要被覆盖', '人格文件一字未动')
for (const p of personaCandidates.slice(1)) ok(existsSync(p) === false, `没有在 ${p} 之外新建文件`)

// ---------------------------------------------------------------------------
console.log('\n③ 鉴权与开关：')
const noToken = await call('POST', '/diary', { date: '2026-11-04' }, false)
eq(noToken.status, 401, '不带令牌 → 401（这条路由同样受 S2 鉴权保护）')
eq(existsSync(paths.diaryPublicPath('2026-11-04')), false, '401 请求没有落盘')

store.saveConfig({ diaryEnabled: false })
const disabled = await call('POST', '/diary', { date: '2026-11-03' })
eq(disabled.status, 403, '日记功能关闭 → 403')
eq(existsSync(paths.diaryPublicPath('2026-11-03')), false, '关闭时没有落盘')
store.saveConfig({ diaryEnabled: true })

// ---------------------------------------------------------------------------
console.log('\n④ 宿主 llm 挂掉时 API 必须回 500 而不是假装成功')
ctx.llm.stream = async function* () {
  await new Promise(() => {}) // 永不吐字
}
diary.__resetDiaryInFlightForTest()
const timeoutDate = '2026-11-01'
const hung = await call('POST', '/diary', { date: timeoutDate })
eq(hung.status, 500, 'llm 超时 → 500（P2-11 的降级链贯通到 API 层）')
eq(hung.payload.ok, false, '响应体 ok:false，调用方可以重试')
eq(existsSync(paths.diaryPublicPath(timeoutDate)), false, '失败路径没有写出半截公开日记')

console.log(`\n结果：${passed} 过 / ${failed} 败`)
rmSync(HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
