/**
 * P2-11 LLM 流超时回归（2026-11-05）：node tests/llm-stream-timeout.test.js
 *
 * 旧实现的四份 `Promise.race([consume, timeout])` 超时后 consume 仍在后台跑完。
 * 这一组用例钉住新消费器的真实保证与**真实局限**：
 *   - 保证：按时返回、超时后不再发起下一次 next()、主动请求关闭迭代器、
 *           晚到的 rejection 不变成 unhandledRejection、四个业务函数都降级为 null；
 *   - 局限（如实断言，不许粉饰）：async generator 卡在 next() 内部时 return() 会排队，
 *           finally 不执行；自定义 async iterable 的 return() 才立即生效。
 *
 * 全程临时 DSH_HOME，日志写在临时目录，不碰真实 ~/.dsh。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-llm-timeout-'))
process.env.DSH_HOME = HOME

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

const lateRejections = []
process.on('unhandledRejection', (reason) => lateRejections.push(String(reason)))

const { consumeLlmStream, __llmStreamDefaultsForTest } = await import('../lib/llm-stream.js')
const refine = await import('../lib/refine.js')
const mood = await import('../lib/mood.js')
const diary = await import('../lib/diary.js')
const { LOG_FILE } = await import('../lib/env.js')

const fakeAgent = { options: { provider: 'p', model: 'm' } }
const short = 40

// ---------------------------------------------------------------------------
console.log('消费器 · 正常与失败路径：')
{
  const llm = {
    async *stream() {
      yield { type: 'text-delta', text: '甲' }
      yield { type: 'text-delta', text: '乙' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const r = await consumeLlmStream(llm, {}, { timeoutMs: 1000 })
  eq([r.ok, r.text, r.timedOut, r.error, r.closeRequested], [true, '甲乙', false, '', false], '正常流：拼接正文、无超时、不请求关闭')
}
{
  const llm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error', message: '配额用尽' } }
      yield { type: 'text-delta', text: '不该被读到' }
    }
  }
  const r = await consumeLlmStream(llm, {}, { timeoutMs: 1000 })
  eq(r.ok, false, '模型报 error finish：ok=false')
  eq(r.error, '', '模型报 error finish：不算「调用失败」，沿用旧行为不记失败日志')
  eq(r.finishReason?.message, '配额用尽', '模型报 error finish：真实 reason 保留')
  eq(r.text, '', '模型报 error finish：后续 chunk 不再消费')
  eq(r.closeRequested, true, '模型报 error finish：请求关闭迭代器')
}
{
  const llm = { async *stream() { throw new Error('模型挂了') } }
  const r = await consumeLlmStream(llm, {}, { timeoutMs: 1000 })
  eq([r.ok, r.timedOut, r.error, r.closeRequested], [false, false, '模型挂了', true], '流抛异常：结构化返回，不 reject')
}
{
  const a = await consumeLlmStream(null, {}, { timeoutMs: 1000 })
  const b = await consumeLlmStream({ stream: () => ({}) }, {}, { timeoutMs: 1000 })
  ok(a.ok === false && a.error !== '', '没有 llm 服务：返回失败而不是抛')
  ok(b.ok === false && b.error.includes('异步可迭代'), 'stream 返回值不可迭代：返回失败而不是抛')
  eq(__llmStreamDefaultsForTest().DEFAULT_TIMEOUT_MS, 30000, '默认超时 30s（与旧实现一致）')
}

// ---------------------------------------------------------------------------
console.log('\n消费器 · 超时与「真取消」的边界：')
{
  // 核心场景：网络挂起、provider 一个字都不吐。
  let finallyHit = 0
  const llm = {
    async *stream() {
      try {
        await new Promise(() => {}) // 永不 resolve
        yield { type: 'text-delta', text: '永远到不了' }
      } finally {
        finallyHit += 1
      }
    }
  }
  const t0 = Date.now()
  const r = await consumeLlmStream(llm, {}, { timeoutMs: short })
  const elapsed = Date.now() - t0
  eq([r.ok, r.timedOut, r.closeRequested], [false, true, true], '挂起流：按时降级、标记超时、请求关闭')
  ok(r.error.includes('超时'), '挂起流：错误原因带「超时」，调用方可据此记日志')
  ok(elapsed < 2000, `挂起流：没有被卡死（实际 ${elapsed} ms）`)
  // 这是本轮最重要的诚实断言：async generator 的 return() 会排队，finally 不执行。
  eq(finallyHit, 0, '如实标注局限：卡在 next() 的 async generator，finally 不会被触发（≠ 底层真 abort）')
}
{
  // 宿主若返回自定义 async iterable（return 是独立方法），关闭是立即生效的。
  let closed = 0
  const llm = {
    stream: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}),
          return: () => { closed += 1; return Promise.resolve({ done: true }) }
        }
      }
    })
  }
  const r = await consumeLlmStream(llm, {}, { timeoutMs: short })
  eq(r.timedOut, true, '自定义 iterable 挂起：按时超时')
  eq(closed, 1, '自定义 iterable：return() 立即生效（这一型宿主才是真关闭）')
}
{
  // 没有 return() 的 async iterable 必须能兜住，不能抛。
  const llm = {
    stream: () => ({
      [Symbol.asyncIterator]() {
        return { next: () => new Promise(() => {}) }
      }
    })
  }
  const r = await consumeLlmStream(llm, {}, { timeoutMs: short })
  eq([r.timedOut, r.closeRequested, r.ok], [true, false, false], '没有 return()：?. 兜底生效，不抛异常')
}
{
  // 超时后若宿主那条 next() 恢复了，绝不能再消费后续 chunk（旧实现会继续跑完整个流）。
  let nextCalls = 0
  let closed = 0
  let release = null
  const llm = {
    stream: () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            nextCalls += 1
            if (nextCalls === 1) return new Promise((resolve) => { release = () => resolve({ done: false, value: { type: 'text-delta', text: '迟到的一块' } }) })
            return Promise.resolve({ done: false, value: { type: 'text-delta', text: '不该再被取' } })
          },
          return: () => { closed += 1; return Promise.resolve({ done: true }) }
        }
      }
    })
  }
  const r = await consumeLlmStream(llm, {}, { timeoutMs: short })
  eq(r.timedOut, true, '迟到 chunk 场景：先超时')
  eq(nextCalls, 1, '超时后不再发起第二次 next()')
  release?.()
  await new Promise((resolve) => setTimeout(resolve, 20))
  eq(nextCalls, 1, '宿主恢复后依然没有继续消费（旧实现会把整条流跑完）')
  eq(r.text, '', '迟到的一块没被拼进结果')
  ok(closed >= 1, '宿主的 return() 被调用过')
}
{
  // signal 是留给宿主将来支持真取消的钩子：不传时参数逐字节不变。
  let seen = null
  const llm = { async *stream(p) { seen = p; yield { type: 'text-delta', text: 'x' } } }
  await consumeLlmStream(llm, { provider: 'p' }, { timeoutMs: 1000 })
  eq(seen, { provider: 'p' }, '未传 signal：参数对象与旧版完全一致（零行为变化）')
  const signal = new AbortController().signal
  await consumeLlmStream(llm, { provider: 'p' }, { timeoutMs: 1000, signal })
  eq(seen?.signal, signal, '传入 signal：透传给宿主，将来支持即自动获得真取消')
}

// ---------------------------------------------------------------------------
console.log('\n四个业务调用点 · 超时必须降级为 null：')
{
  const hang = { async *stream() { await new Promise(() => {}); yield { type: 'text-delta', text: 'x' } } }
  const r = await refine.refineCandidates(hang, fakeAgent, [{ text: '我不吃辣' }], { timeoutMs: short })
  eq(r, null, 'refineCandidates：超时退回 null（调用方退回原话直存）')
}
{
  const hang = { async *stream() { await new Promise(() => {}); yield { type: 'text-delta', text: 'x' } } }
  const noted = []
  const r = await mood.judgeMood(hang, fakeAgent, '在吗', '在的', '', { owner: '树树', judgeTimeoutMs: short }, (tag, msg) => noted.push(msg))
  eq(r, null, 'judgeMood：超时丢弃这一轮（沿用旧心情值）')
  ok(noted.some((m) => m.includes('超时')), 'judgeMood：超时有日志，不留「心情停住」的无头案')
}
{
  const hang = { async *stream() { await new Promise(() => {}); yield { type: 'text-delta', text: 'x' } } }
  const config = { diarySummarizeTimeoutMs: short }
  const a = await diary.summarizeConversations(hang, '今天聊了天', config, fakeAgent)
  const b = await diary.composeDiaryText(hang, config, fakeAgent, 'public', {
    dateStr: '2026-11-05', summary: '今天聊了天', recentDiaries: { public: '' }
  })
  eq([a, b], [null, null], 'summarizeConversations / composeDiaryText：超时都返回 null')
  if (existsSync(LOG_FILE())) {
    const log = readFileSync(LOG_FILE(), 'utf8')
    ok(log.includes('超时'), '日记两条链路把超时原因写进了日志')
  } else {
    ok(false, '日记两条链路把超时原因写进了日志（日志文件不存在）')
  }
}
{
  // 正常流不能因为重构而回归：四个函数各跑一次 happy path。
  const good = {
    async *stream() {
      yield { type: 'text-delta', text: '[{"text":"我不吃辣","importance":60}]' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const r = await refine.refineCandidates(good, fakeAgent, [{ text: '我不吃辣' }], { timeoutMs: 1000 })
  ok(Array.isArray(r) && r.length === 1, 'refineCandidates：正常流仍能解析出记忆条目')

  const goodDiary = { async *stream() { yield { type: 'text-delta', text: '今天过得平静。' } } }
  const text = await diary.composeDiaryText(goodDiary, { diarySummarizeTimeoutMs: 1000 }, fakeAgent, 'public', {
    dateStr: '2026-11-05', summary: '今天聊了天', recentDiaries: { public: '' }
  })
  eq(text, '今天过得平静。', 'composeDiaryText：正常流正文逐字不变')
}

// ---------------------------------------------------------------------------
console.log('\n收尾：')
await new Promise((resolve) => setTimeout(resolve, 60))
eq(lateRejections, [], '没有未处理的 Promise rejection（晚到的 next() 已被消化）')
// 不用恒真断言：真的去数活动 handle 里有没有残留的 Timeout。
const liveTimers = process._getActiveHandles().filter((h) => h?.constructor?.name === 'Timeout')
eq(liveTimers.length, 0, '没有残留 Timeout handle（每处 finally 都 clearTimeout 了）')

console.log(`\n结果：${passed} 过 / ${failed} 败`)
rmSync(HOME, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
