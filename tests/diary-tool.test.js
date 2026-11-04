/**
 * 日记工具 + 「她自己写」链路测试：node tests/diary-tool.test.js，退出码 0 = 全过。
 *
 * 2026-11-04 把日记从「插件代笔」改成「先投消息让她写，没写成再兜底」。
 * 这条链路的风险全在**判断错**上，所以测试重心是三个判据：
 *   ① 日期校验 —— 放开的话她能写未来和远古的日记，看门狗会天天认为「昨天没写」；
 *   ② 已存在就别覆盖 —— 她写好的日记不能被兜底生成冲掉（这是最伤的一种失败）；
 *   ③ 该兜底时要真兜底 —— 没绑定会话时日记不能就这么丢了。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'soul-diary-tool-test-'))

const { checkDiaryDate, registerDiaryTool } = await import('../lib/diary-tool.js')
const { diaryJsonlPath, diaryPrivatePath, diaryPublicPath, ensureDirs } = await import('../lib/paths.js')
const { collectForDiary, resetDiaryCursor, runDiaryOnce, todayKey, writeDiaryFile, yesterdayKey } = await import('../lib/diary.js')
const { saveConfig } = await import('../lib/store.js')

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

const tmpRoot = process.env.DSH_HOME
ensureDirs()

// --------------------------------------------------------------------------

console.log('日期校验（放开了就会天天重写）：')
{
  const now = new Date('2026-11-04T10:00:00').getTime()
  eq(checkDiaryDate('', now).date, '2026-11-03', '不填日期 = 昨天')
  eq(checkDiaryDate('2026-11-03', now).ok, true, '昨天合法')
  eq(checkDiaryDate('2026-11-04', now).ok, true, '今天也算合法（当天补写）')
  eq(checkDiaryDate('2026-11-05', now).ok, false, '未来被拒绝')
  eq(checkDiaryDate('2027-01-01', now).ok, false, '远期未来被拒绝')
  eq(checkDiaryDate('2026-10-01', now).ok, false, '34 天前被拒绝（超出补写范围）')
  eq(checkDiaryDate('2026-02-30', now).ok, false, '2 月 30 号这种不存在的日期被拒绝')
  eq(checkDiaryDate('2026/11/03', now).ok, false, '斜杠格式被拒绝')
  eq(checkDiaryDate('昨天', now).ok, false, '中文日期被拒绝')
}

console.log('\nsoul_diary 工具：')
{
  let captured = null
  const ctx = {
    tools: {
      register: (def) => {
        captured = def
        return () => {}
      }
    }
  }
  const dispose = registerDiaryTool(ctx)
  ok(typeof dispose === 'function', '注册返回 disposer')
  ok(captured !== null && captured.name === 'soul_diary', '工具名是 soul_diary')
  ok(Array.isArray(captured?.parameters?.properties?.action?.enum), 'action 是枚举（编译好的 JSON Schema）')
  ok(captured?.output?.schema !== undefined, '声明了 output schema（不声明 register 会抛）')

  const date = yesterdayKey(Date.now())

  const w1 = await captured.execute({ action: 'write', kind: 'public', date, content: '今天写了一段' })
  eq(w1.ok, true, '写公开日记成功')
  ok(readFileSync(diaryPublicPath(date), 'utf8').includes('今天写了一段'), '文件里有正文')
  ok(readFileSync(diaryPublicPath(date), 'utf8').startsWith('【公开】'), '首行【公开】由插件补，不靠她自觉')

  const w2 = await captured.execute({ action: 'write', kind: 'private', date, content: '这段只有我自己看' })
  eq(w2.ok, true, '写私密日记成功')
  ok(readFileSync(diaryPrivatePath(date), 'utf8').startsWith('【私密】'), '私密篇首行是【私密】')

  // 2026-11-04 修 B2：同名默认拒绝覆盖（跟 writeNote 口径一致）。
  // 原来直接写，而她漏传 date 时会默认昨天 —— 一次调用就能静默替换掉看门狗写好的那篇。
  const w3 = await captured.execute({ action: 'write', kind: 'public', date, content: '重写一遍' })
  eq(w3.ok, false, '同名再写默认被拒绝（B2）')
  ok(w3.message.includes('overwrite'), '拒绝时告诉她要带 overwrite=true')
  eq(readFileSync(diaryPublicPath(date), 'utf8').includes('今天写了一段'), true, '被拒时原内容没被清掉')

  const w3b = await captured.execute({ action: 'write', kind: 'public', date, content: '重写一遍', overwrite: true })
  eq(w3b.ok, true, '带 overwrite 才允许整篇替换')
  ok(w3b.message.includes('重写'), '覆盖时明确告知是重写')
  eq(readFileSync(diaryPublicPath(date), 'utf8').includes('重写一遍'), true, '覆盖生效')

  eq((await captured.execute({ action: 'write', kind: 'public', date, content: '   ' })).ok, false, '空正文被拒绝')
  eq((await captured.execute({ action: 'write', kind: 'soso', date, content: 'x' })).ok, false, '非法 kind 被拒绝')
  eq((await captured.execute({ action: 'write', kind: 'public', date: '2030-01-01', content: 'x' })).ok, false, '未来日期被拒绝')
  eq((await captured.execute({ action: 'write', kind: 'public', date: '../../x', content: 'x' })).ok, false, '路径穿越被拒绝')

  const look = await captured.execute({ action: 'look' })
  eq(look.ok, true, 'look 可用')
  ok(look.items.length === 7, 'look 列最近 7 天')
  ok(look.items.some((item) => item.text.includes('公开✓')), 'look 能看出哪几天写了')
}

console.log('\n已存在的日记不能被兜底覆盖（最伤的一种失败）：')
{
  const date = '2026-11-03'
  writeDiaryFile('public', date, '这是她自己写的公开日记')
  writeDiaryFile('private', date, '这是她自己写的私密日记')

  let llmCalls = 0
  // 没有 agent、没有可用的 llm —— 如果代码走错分支，这里会抛或者被调用
  const ctx = {
    llm: {
      stream: async function* () {
        llmCalls += 1
        throw new Error('不该被调用：她已经写好了')
      }
    }
  }

  const done = await runDiaryOnce(ctx, date)
  eq(done, true, '两篇都在 → 返回成功')
  eq(llmCalls, 0, '一次生成都没调（没把她写的东西冲掉）')
  eq(readFileSync(diaryPublicPath(date), 'utf8').includes('她自己写的公开日记'), true, '公开篇原样还在')
  eq(readFileSync(diaryPrivatePath(date), 'utf8').includes('她自己写的私密日记'), true, '私密篇原样还在')
}

console.log('\n没绑定会话时要真的兜底（否则日记就丢了）：')
{
  // 这一天两篇都没有，且没有 agent —— 应该走插件生成。
  // 必须配上日记专用模型，否则 composeDiaryText 在「取不到模型路由」那一步就返回了，
  // 根本走不到 llm.stream，那样测的就不是兜底路径了。
  saveConfig({ diarySummarizeProvider: 'test-provider', diarySummarizeModel: 'test-model' })
  const date = '2026-11-02'
  let streamed = 0
  const ctx = {
    llm: {
      stream: async function* () {
        streamed += 1
        // 故意抛错：只验证「兜底路径被走到」，不验证生成内容
        throw new Error('测试里不需要真的生成')
      }
    }
  }
  const done = await runDiaryOnce(ctx, date)
  eq(streamed, 1, '确实调了兜底生成（公开篇一次）')
  eq(done, false, '生成失败时如实返回 false（不假装写完了）')
  const log = readFileSync(join(tmpRoot, 'agents', 'soul.log'), 'utf8')
  ok(log.includes('改用插件兜底生成'), '日志写清了「让她写没成 → 兜底」这一步')
}

console.log('\n端到端：她收到消息真的写了（整条链路）：')
{
  // 假 agent：followup 收到消息后，照消息里让她用的 kind 真去写文件。
  // 这是对「投递 → 等文件 → 认定为 agent 写的」整条链路的验证，
  // 也是这次改动唯一真正需要跑通的路径。
  const date = '2026-11-01'
  const asked = []
  const fakeAgent = {
    followup: (message) => {
      const text = String(message?.content?.[0]?.text ?? '')
      // source.kind 必须是 schedule，否则「叫她写日记」会被记成一条对话
      asked.push(message?.source?.kind)
      if (text.includes('kind=public')) writeDiaryFile('public', date, '她收到消息后写的公开日记')
      else if (text.includes('kind=private')) writeDiaryFile('private', date, '她收到消息后写的私密日记')
    }
  }

  saveConfig({ diarySessionId: 'test-session', diaryAgentWrite: true })
  let llmCalls = 0
  const ctx = {
    agents: {
      get: (id) => (id === 'test-session' ? fakeAgent : undefined)
    },
    llm: {
      stream: async function* () {
        llmCalls += 1
        throw new Error('不该兜底：她自己写的')
      }
    }
  }

  const done = await runDiaryOnce(ctx, date)
  eq(done, true, '整体成功')
  eq(asked.length, 2, '两条消息都投了（公开一条、私密一条）')
  eq(asked.every((kind) => kind === 'schedule'), true, 'source.kind 都是 schedule（不会污染记忆和心情）')
  eq(llmCalls, 0, '一次兜底生成都没调')
  eq(readFileSync(diaryPublicPath(date), 'utf8').includes('她收到消息后写的公开日记'), true, '公开篇是她写的那版')
  eq(readFileSync(diaryPrivatePath(date), 'utf8').includes('她收到消息后写的私密日记'), true, '私密篇是她写的那版')
}

console.log('\n同一天并发触发只写一次（2026-11-04 修 ④）：')
{
  // 启动时 startDiaryTimer 排的 +5 秒启动写，和 index.js 立刻发起的 runCatchUp，
  // 可能同时盯上同一天。原来没有 in-flight 锁 → 各投一次消息、各生成一次，
  // 两篇还可能来自不同次生成（公开 A 次、私密 B 次）。
  const { __resetDiaryInFlightForTest } = await import('../lib/diary.js')
  __resetDiaryInFlightForTest()
  saveConfig({ diarySessionId: 'test-session', diaryAgentWrite: true, diaryAgentTimeoutMs: 600 })

  const date = '2026-10-31'
  const asked = []
  // 收到消息但不写文件 → 第一次会等到超时再走兜底
  const fakeAgent = { followup: () => { asked.push(Date.now()) } }
  const ctx = {
    agents: { get: () => fakeAgent },
    llm: { stream: async function* () { throw new Error('测试里不生成') } }
  }

  const first = runDiaryOnce(ctx, date)
  const second = await runDiaryOnce(ctx, date)
  eq(second, false, '同一天的第二次触发被锁挡住（立刻返回，不排队不重复投递）')
  await first
  eq(asked.length, 1, '全程只投了一条消息（公开那篇），没有重复打扰她')

  const log = readFileSync(join(tmpRoot, 'agents', 'soul.log'), 'utf8')
  ok(log.includes('正在写（另一条流程在跑）'), '日志写清了为什么跳过')

  // 锁必须释放，否则那天以后再也写不了
  writeDiaryFile('public', '2026-10-30', '已经写好的公开')
  writeDiaryFile('private', '2026-10-30', '已经写好的私密')
  const other = await runDiaryOnce(ctx, '2026-10-30')
  eq(other, true, '锁已释放：另一天（两篇已存在）照常返回成功')
}

console.log('\n写盘失败时游标不能白推（2026-11-04 修 B3）：')
{
  // 原实现是「先把游标推到这批事件的末尾，再逐条 append」，而 append 内部把异常吞成日志。
  // 于是 ENOSPC / 文件被占那一次，这批对话既不进 JSONL、下一轮也不会再扫 —— 永久丢失。
  // 这里用「同名目录冒充 jsonl 文件」制造 EISDIR。
  const sid = 'seek-test'
  resetDiaryCursor(sid)
  const events = []
  const session = {
    header: { id: sid, cwd: '' },
    seq: 3,
    firstLiveSeq: 0,
    snapshotEvents: (from, to) => events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
  }
  const agent = { session }

  collectForDiary(agent) // 第一次只把游标推到当前位置（不回扫历史）

  events.push({ seq: 4, type: 'user/message', payload: { content: [{ type: 'text', text: '写盘会失败的一条' }] } })
  session.seq = 4

  const badPath = diaryJsonlPath(todayKey(Date.now()))
  mkdirSync(badPath, { recursive: true })

  const first = collectForDiary(agent)
  eq(first.appended, 0, '写盘失败时一条都没记成（如实返回 0）')

  // 修好文件系统：再扫一次，同一条必须还能捞回来
  rmSync(badPath, { recursive: true, force: true })
  const second = collectForDiary(agent)
  eq(second.appended, 1, '修好之后同一条被重扫并写入（游标没有白推）')
  ok(readFileSync(badPath, 'utf8').includes('写盘会失败的一条'), '内容真的进了 JSONL')

  resetDiaryCursor(sid)
}

console.log('\n写盘一直失败要能放弃，否则会话永久静音（新③）：')
{
  // 「写不进就停住游标」没有退路：坏目标（同名目录/磁盘满/权限）会让这个会话
  // 从此一条都不再记录，且每轮重试。这里验证连续失败 3 次后会放弃那一条并继续。
  const sid = 'seek-giveup-test'
  resetDiaryCursor(sid)
  const events = []
  const session = {
    header: { id: sid, cwd: '' },
    seq: 3,
    firstLiveSeq: 0,
    snapshotEvents: (from, to) => events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
  }
  const agent = { session }

  collectForDiary(agent)
  events.push({ seq: 4, type: 'user/message', payload: { content: [{ type: 'text', text: '卡住的一条' }] } })
  session.seq = 4

  const badPath = diaryJsonlPath(todayKey(Date.now()))
  // 前面的用例可能已经在这个路径上留下文件，先清掉再建同名目录
  rmSync(badPath, { recursive: true, force: true })
  mkdirSync(badPath, { recursive: true })
  for (let i = 0; i < 3; i += 1) collectForDiary(agent)

  const gaveUp = collectForDiary(agent)
  eq(gaveUp.appended, 0, '放弃那一条之后这批没有可写的')

  const log = readFileSync(join(tmpRoot, 'agents', 'soul.log'), 'utf8')
  ok(log.includes('放弃这一条并推进游标'), '日志写明放弃了哪一条')

  // 修好之后，新消息必须照常记录（会话不能永久静音）
  rmSync(badPath, { recursive: true, force: true })
  events.push({ seq: 5, type: 'user/message', payload: { content: [{ type: 'text', text: '放弃之后的新消息' }] } })
  session.seq = 5
  const after = collectForDiary(agent)
  eq(after.appended, 1, '修好文件系统后，新消息照常记录')
  ok(readFileSync(badPath, 'utf8').includes('放弃之后的新消息'), '内容真的写进去了')

  resetDiaryCursor(sid)
}

console.log('\n收尾：')
{
  rmSync(tmpRoot, { recursive: true, force: true })
  ok(true, '临时目录已清理')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
