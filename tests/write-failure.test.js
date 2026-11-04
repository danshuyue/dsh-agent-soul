/**
 * 写盘失败测试（2026-11-04）：node tests/write-failure.test.js，退出码 0 = 全过。
 *
 * 这一组钉的是三条「会丢数据 / 会骗人」的 bug：
 *   ① 记忆写卡失败时游标不推进、下一轮重试能补上（原来写卡之前就推游标 → 永久丢）
 *   ② 同一个位置连续失败 3 次就放弃并推进游标（不然永久失败的目标会把每轮都卡住）
 *   ③ POST /persona 写盘失败必须回非 200（原来无条件 200「已保存」）
 * 另外顺手钉住 ③ 的配套：失败日志走同一套分频（每小时的 1 次 + 第 5 次）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const HOME = mkdtempSync(join(tmpdir(), 'soul-write-fail-'))
process.env.DSH_HOME = HOME

const {
  collectCandidates,
  commitIngestBatch,
  failIngestBatch
} = await import('../lib/extract.js')
const { createCard, saveCard } = await import('../lib/memory.js')
const { LOG_FILE, __resetNoteThrottleForTest, noteThrottled } = await import('../lib/env.js')
const { registerApi, API_PREFIX } = await import('../lib/api.js')
const { globalPersonaPath } = await import('../lib/paths.js')

/** 造一条和真机一模一样的 user/message。 */
const realEvent = (seq, text, kind = 'user') => ({
  type: 'user/message',
  seq,
  time: Date.now(),
  data: { content: [{ type: 'text', text }], source: { kind }, role: 'user', id: `id-${seq}` },
  surfaceOp: 'append'
})

function makeAgent(events, id) {
  return {
    session: {
      header: { id },
      get seq() {
        return events.length > 0 ? events[events.length - 1].seq : 0
      },
      firstLiveSeq: 0,
      snapshotEvents: (from, to) => events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
    }
  }
}

const logText = () => {
  try {
    return readFileSync(LOG_FILE(), 'utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
console.log('① 写卡失败：游标不推进，下一轮重试能补上')
{
  const events = []
  const agent = makeAgent(events, 'session-retry-001')
  collectCandidates(agent, { limit: 12 }) // 第一次只见会话：只初始化游标

  events.push(realEvent(1, '树树是烟台大学机器人工程专业大二学生'))
  const first = collectCandidates(agent, { limit: 12 })
  eq(first.candidates.length, 1, '扫到一条值得记的')
  ok(first.batch !== null, '这一批带着 batch（游标推进交给调用方）')

  const outcome = failIngestBatch(first.batch, 'global.json 被设成只读')
  eq(outcome.retry, true, '第一次失败：只重试，不放弃')
  eq(outcome.count, 1, '失败次数 1')

  const retry = collectCandidates(agent, { limit: 12 })
  eq(retry.candidates.length, 1, '游标没推进 → 下一轮还能扫到同一批（这就是重试）')
  eq(retry.candidates[0]?.text, first.candidates[0]?.text, '重试到的还是同一条')
  eq(retry.from, first.from, '扫描起点也没变')

  // 这一次"写成功了"
  eq(commitIngestBatch(retry.batch), true, '写成功后结账')
  const after = collectCandidates(agent, { limit: 12 })
  eq(after.candidates.length, 0, '写成功之后才推进游标：同一批不会重复记')

  // 落盘这一层真的会把失败报上来吗 —— ingestRaw 的判断全靠它
  const broken = saveCard(join(HOME, 'no-such-dir', 'card.json'), createCard('global'))
  eq(broken?.ok, false, 'saveCard 写盘失败回 ok:false（不是静默回一份卡）')
  ok(typeof broken?.error === 'string' && broken.error !== '', '失败原因也带回来了')
}

// ---------------------------------------------------------------------------
console.log('\n② 连续失败 3 次：放弃这一批并推进游标（不然永久坏目标会把每轮都卡住）')
{
  const events = []
  const agent = makeAgent(events, 'session-giveup-001')
  collectCandidates(agent, { limit: 12 })

  events.push(realEvent(1, '树树的目标是当嵌入式工程师，偏软件方向'))
  const outcomes = []
  for (let i = 1; i <= 3; i += 1) {
    const round = collectCandidates(agent, { limit: 12 })
    eq(round.candidates.length, 1, `第 ${i} 次重试仍能扫到这一批`)
    outcomes.push(failIngestBatch(round.batch, '磁盘满'))
  }
  eq(outcomes[0].givenUp, false, '第 1 次不放弃')
  eq(outcomes[1].givenUp, false, '第 2 次不放弃')
  eq(outcomes[2].givenUp, true, '第 3 次放弃')
  eq(outcomes[2].count, 3, '放弃时的失败计数是 3')

  const afterGiveUp = collectCandidates(agent, { limit: 12 })
  eq(afterGiveUp.candidates.length, 0, '放弃后游标已推进：这个会话不会再卡在这一批上')
  ok(logText().includes('放弃这一批'), '放弃这件事写了日志（数据真的丢了，必须留痕）')

  // 放弃之后新事件照常能被提取（会话没有因此静音）
  events.push(realEvent(2, '树树打算明年参加蓝桥杯嵌入式赛道'))
  const nextRound = collectCandidates(agent, { limit: 12 })
  eq(nextRound.candidates.length, 1, '放弃只丢那一批，后面的新消息照常提取')
  commitIngestBatch(nextRound.batch)
}

// ---------------------------------------------------------------------------
console.log('\n③ POST /persona：写盘失败必须回非 200，成功仍然是 200')
{
  let handler = null
  registerApi({
    webServer: {
      register: (spec) => {
        handler = spec.handler
        return () => {}
      }
    }
  })
  ok(typeof handler === 'function', '路由注册到了（假的）webServer 上')

  /** 假 req：readBody 只用 data/end/error 三个事件。 */
  function fakeReq(method, url, body) {
    const listeners = new Map()
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1:53397' },
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

  /** 假 res：json() 只用 writeHead + end。 */
  function fakeRes() {
    const out = { status: 0, body: '' }
    return {
      writeHead(code) {
        out.status = code
      },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) out.body += String(chunk)
      },
      result: out
    }
  }

  const call = async (method, path, body) => {
    const res = fakeRes()
    await handler(fakeReq(method, `${API_PREFIX}${path}`, body), res)
    return { status: res.result.status, payload: JSON.parse(res.result.body || '{}') }
  }

  // 让 atomicWrite 必然失败：人格路径上放一个**目录**，rename/拷贝都盖不过去
  const personaFile = globalPersonaPath()
  mkdirSync(personaFile, { recursive: true })

  const failedWrite = await call('POST', '/persona', { kind: 'global', text: '新人格正文' })
  ok(failedWrite.status !== 200, `写盘失败回非 200（实际 ${failedWrite.status}）`)
  eq(failedWrite.payload.ok, false, 'body 里 ok:false')
  ok(String(failedWrite.payload.error ?? '').includes('写盘失败'), `带 error 文案（${String(failedWrite.payload.error)}）`)
  ok(logText().includes('人格保存失败'), '记了一条 api 日志（设置页看不见原因时还能查）')

  // 恢复成可写：同一条路必须能回 200 —— 修 bug 不能把正常保存也堵了
  rmSync(personaFile, { recursive: true, force: true })
  const goodWrite = await call('POST', '/persona', { kind: 'global', text: '新人格正文' })
  eq(goodWrite.status, 200, '正常写入仍是 200')
  eq(goodWrite.payload.ok, true, '正常写入 ok:true')
  ok(existsSync(personaFile) === true, '文件真的写出来了')
  eq(readFileSync(personaFile, 'utf8'), '新人格正文', '内容就是提交的那份')
}

// ---------------------------------------------------------------------------
console.log('\n④ 失败日志分频：同一小时只记第 1 次和第 5 次（三处共用 env.js 的实现）')
{
  __resetNoteThrottleForTest()
  const firstLine = `分频首条-${process.pid}`
  const fifthLine = `分频第五条-${process.pid}`
  const offset = logText().length
  for (let i = 0; i < 7; i += 1) {
    noteThrottled('test', 'throttle-case', firstLine, { againAt: 5, againMessage: fifthLine })
  }
  // 换个 key 不受影响：每个 key 各算各的
  noteThrottled('test', 'throttle-other', `另一个 key-${process.pid}`)

  const lines = logText().slice(offset).split('\n')
  eq(lines.filter((line) => line.includes(firstLine)).length, 1, '第 1 次照常记（真实原因只出现一次）')
  eq(lines.filter((line) => line.includes(fifthLine)).length, 1, '第 5 次补一句「这不像偶发」')
  eq(lines.filter((line) => line.includes(`另一个 key-${process.pid}`)).length, 1, '不同 key 互不影响')
  eq(lines.filter((line) => line.includes(firstLine) || line.includes(fifthLine)).length, 2, '七次调用一共只记两行')
}

rmSync(HOME, { recursive: true, force: true })

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
