/**
 * 心里话（2026-11-21 / 0.10.2）：node tests/self.test.js
 *
 * 覆盖：
 *   ① 6 点门槛（selfDue / maybeRunSelfAt）
 *   ② 按月文件：`## YYYY-MM-DD` 解析、新的一天在最上面、删掉某一天
 *   ③ 触发消息：绝对路径、昨天日期、`## ` 格式要求，且**不投对话全文**
 *   ④ 她没写：日志一行「昨天没有心里话」，不重试、不催、不替她写
 *   ⑤ 注入：最近 N 天、每条截 selfInjectChars 字
 *   ⑥ GET /self/list、POST /self/save
 *   ⑦ 配置默认值与夹取
 *
 * 用例全部用临时 DSH_HOME；不联网、不调模型。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

// 临时 DSH_HOME：所有文件写这里
const sandbox = mkdtempSync(join(tmpdir(), 'soul-self-'))
process.env.DSH_HOME = sandbox

const diary = await import('../lib/diary.js')
const paths = await import('../lib/paths.js')
const store = await import('../lib/store.js')
const { normalizeConfig } = await import('../lib/memory.js')
const { LOG_FILE } = await import('../lib/env.js')
const { handleGetSelfList, handlePostSelfSave } = await import('../lib/http/routes/self.js')

const {
  composeSelfMessage,
  hasSelfEntry,
  listSelfEntries,
  maybeRunSelfAt,
  parseSelfSections,
  readRecentSelfEntries,
  readSelfEntry,
  renderSelfSection,
  runSelfOnce,
  selfDue,
  writeSelfEntry
} = diary

paths.ensureDirs()

function soulLog() {
  try {
    return readFileSync(LOG_FILE(), 'utf8')
  } catch {
    return ''
  }
}

/** 固定本地时间（UTC+8 机器上就是 7 点/2 点，跨时区也只看本地小时）。 */
const DAY = new Date(2026, 10, 21, 7, 0, 0, 0).getTime()
const NIGHT = new Date(2026, 10, 21, 2, 0, 0, 0).getTime()

// ---------------------------------------------------------------------------
console.log('① 6 点门槛')
// ---------------------------------------------------------------------------
ok(selfDue(NIGHT) === false, '0 点不算到点')
ok(selfDue(new Date(2026, 10, 21, 5, 59).getTime()) === false, '5:59 还不行')
ok(selfDue(DAY) === true, '6 点之后开始检查')
ok(selfDue(new Date(2026, 10, 21, 6, 0).getTime()) === true, '正好 6:00 也算')

// ---------------------------------------------------------------------------
console.log('② 按月文件：解析 / 新的一天在最上面 / 删除')
// ---------------------------------------------------------------------------
{
  const added20 = writeSelfEntry('2026-11-20', '第一天\n\n第二段')
  const added19 = writeSelfEntry('2026-11-19', '前一天')
  ok(added20.ok && added19.ok, '能写两天的心里话')
  const file = paths.diarySelfMonthPath('2026-11')
  const text = readFileSync(file, 'utf8')
  ok(text.startsWith('# 2026-11\n'), '文件头是 # YYYY-MM')
  ok(text.indexOf('## 2026-11-20') < text.indexOf('## 2026-11-19'), '新的一天在文件最上面')
  ok(text.includes('## 2026-11-20') && text.includes('第一天'), '小节标题与正文都在')

  const sections = parseSelfSections(text)
  eq([...sections.keys()], ['2026-11-20', '2026-11-19'], '解析出两个小节')
  ok(sections.get('2026-11-20').includes('第二段'), '多段正文完整读出')
  ok(readSelfEntry('2026-11-20').includes('第一天'), '按日期读正文')
  ok(hasSelfEntry('2026-11-20') === true, 'hasSelfEntry 认这一天')
  ok(hasSelfEntry('2026-11-18') === false, '没写的那天是 false')

  const deleted = writeSelfEntry('2026-11-20', '')
  ok(deleted.ok === true, 'text 为空 = 删掉该小节')
  ok(hasSelfEntry('2026-11-20') === false, '删掉后读不到那一天')
  ok(hasSelfEntry('2026-11-19') === true, '其它小节不受影响')

  ok(writeSelfEntry('not-a-date', 'x').ok === false, '非法日期拒绝写盘')
}

// ---------------------------------------------------------------------------
console.log('③ 触发消息：只给日期、绝对路径和格式，不投对话全文')
// ---------------------------------------------------------------------------
store.saveConfig({ selfEnabled: true, selfSessionId: 'sess-self', selfTone: '平实一点' })

const sent = []
function makeCtx(onFollowup) {
  const agent = {
    followup(message) {
      const text = String(message?.content?.[0]?.text ?? '')
      sent.push(text)
      if (typeof onFollowup === 'function') onFollowup(text)
    }
  }
  return { agents: { get: (id) => (id === 'sess-self' ? agent : undefined) } }
}

// 那天的对话流水：里面放一个哨兵，验证它不会被投给她
writeFileSync(
  paths.diaryJsonlPath('2026-11-20'),
  JSON.stringify({ t: DAY - 12 * 3600_000, role: 'user', text: 'SECRET-CONVERSATION-CONTENT' }) + '\n',
  'utf8'
)

{
  // 先清掉这个月，保证昨天还没有小节
  writeSelfEntry('2026-11-20', '')
  const logBefore = soulLog().length
  const result = await runSelfOnce(makeCtx(), { now: DAY, waitMs: 80 })
  eq(result.wrote, false, '她没写 → wrote=false')
  eq(sent.length, 1, '只投一条消息')
  const message = sent[0]
  const monthFile = paths.diarySelfMonthPath('2026-11')
  ok(message.includes('2026-11-20'), '消息里有昨天日期')
  ok(message.includes(monthFile), `消息里有绝对路径（${monthFile}）`)
  ok(message.includes('## 2026-11-20'), '消息里写明 ## 日期 格式')
  ok(message.includes('新的一天加在文件最上面'), '消息里写清新的一天加最上面')
  ok(message.includes('写完不用回我'), '消息里说不用回')
  ok(message.includes('语气：平实一点'), '消息里带 selfTone')
  ok(!message.includes('SECRET-CONVERSATION-CONTENT'), '没有把对话全文投过去')
  ok(message.length < 400, `消息很短（${message.length} 字）`)
  const log = soulLog().slice(logBefore)
  ok(log.includes('昨天没有心里话（2026-11-20）'), '她没写 → 日志一行「昨天没有心里话」')
  ok(!readSelfEntry('2026-11-20').includes('第一天'), '插件不替她写')
}

{
  // 她收到消息后自己写：插件只读，不解析她的回复
  writeSelfEntry('2026-11-19', '')
  const ctx = makeCtx(() => { writeSelfEntry('2026-11-19', '她收到提醒后自己写的一段') })
  const result = await runSelfOnce(ctx, { now: DAY, dateStr: '2026-11-19', waitMs: 1000 })
  eq(result.wrote, true, '她写出来 → wrote=true')
  ok(readSelfEntry('2026-11-19').includes('她收到提醒后自己写的一段'), '正文由她自己落盘')
}

// ---------------------------------------------------------------------------
console.log('④ 0 点不投（6 点门槛真的挡住触发）')
// ---------------------------------------------------------------------------
{
  writeSelfEntry('2026-11-20', '')
  sent.length = 0
  const result = await maybeRunSelfAt(makeCtx(), NIGHT, { waitMs: 20 })
  eq(result.reason, 'before-6', '0 点返回 before-6')
  eq(sent.length, 0, '0 点一条消息都没投')
}

// ---------------------------------------------------------------------------
console.log('⑤ 注入：最近 N 天、每条截 selfInjectChars 字')
// ---------------------------------------------------------------------------
{
  // 用相对「今天」的日期写，保证 listSelfEntries 的窗口能读到
  const today = diary.todayKey(DAY)
  const yesterday = diary.yesterdayKey(DAY)
  const longText = '很'.repeat(500)
  writeSelfEntry(today, '今天的心里话')
  writeSelfEntry(yesterday, longText)

  const section = renderSelfSection({ selfInjectDays: 3, selfInjectChars: 100 }, DAY)
  ok(section.startsWith('### 最近几次心里话'), '注入段标题是「最近几次心里话」')
  ok(section.includes(today) && section.includes(yesterday), '最近两天都在')
  const lines = section.split('\n').filter((line) => line.startsWith(today) || line.startsWith(yesterday))
  eq(lines.length, 2, '两天各一行')
  const longLine = lines.find((line) => line.startsWith(yesterday))
  const body = longLine.slice(longLine.indexOf('：') + 1)
  ok(body.length <= 100, `正文截到 selfInjectChars（实际 ${body.length}）`)
  ok(body.endsWith('…'), '截断处有省略号')

  const recent = readRecentSelfEntries(3, DAY)
  ok(recent.length >= 2 && recent[0].date === today, '最近条目从新到旧')
}

// ---------------------------------------------------------------------------
console.log('⑥ GET /self/list、POST /self/save')
// ---------------------------------------------------------------------------
function fakeReq(body) {
  const listeners = new Map()
  const req = {
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(cb)
      return req
    }
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

{
  writeSelfEntry('2026-11-20', '十一月的第一天心里话')
  writeSelfEntry('2026-11-19', '十一月的第二天心里话')
  const res = fakeRes()
  await handleGetSelfList(null, {}, res, new URLSearchParams('days=14'), '/self/list')
  const payload = JSON.parse(res.result.body)
  eq(res.result.status, 200, 'GET /self/list → 200')
  ok(payload.ok === true, 'ok=true')
  const row20 = payload.list.find((row) => row.date === '2026-11-20')
  const row19 = payload.list.find((row) => row.date === '2026-11-19')
  ok(row20 && row20.hasText && row20.text.includes('第一天心里话'), '2026-11-20 读得出来')
  ok(row19 && row19.hasText && row19.text.includes('第二天心里话'), '2026-11-19 读得出来')

  // 手动改：插件写盘
  const saveRes = fakeRes()
  await handlePostSelfSave({}, fakeReq({ date: '2026-11-21', text: '人改的一段' }), saveRes, new URLSearchParams(), '/self/save')
  eq(saveRes.result.status, 200, 'POST /self/save → 200')
  ok(readSelfEntry('2026-11-21') === '人改的一段', '手动保存的内容落盘')

  // 手动删：text 为空
  const delRes = fakeRes()
  await handlePostSelfSave({}, fakeReq({ date: '2026-11-21', text: '' }), delRes, new URLSearchParams(), '/self/save')
  eq(delRes.result.status, 200, 'POST /self/save 删除 → 200')
  ok(hasSelfEntry('2026-11-21') === false, '删掉后小节消失')

  const badRes = fakeRes()
  await handlePostSelfSave({}, fakeReq({ date: '../x', text: 'x' }), badRes, new URLSearchParams(), '/self/save')
  eq(badRes.result.status, 400, '非法日期 → 400')
}

// ---------------------------------------------------------------------------
console.log('⑦ 配置默认值与夹取')
// ---------------------------------------------------------------------------
{
  const cfg = store.loadConfig()
  ok(cfg.selfEnabled === true, 'selfEnabled 默认 true')
  ok(cfg.selfSessionId === 'sess-self', 'selfSessionId 从配置读回')
  ok(cfg.selfTone === '平实一点', 'selfTone 从配置读回')
  ok(cfg.selfInjectDays === 3, 'selfInjectDays 默认 3')
  ok(cfg.selfInjectChars === 400, 'selfInjectChars 默认 400')
  ok(normalizeConfig({ selfInjectDays: 0 }).selfInjectDays === 1, 'selfInjectDays 低于下限夹到 1')
  ok(normalizeConfig({ selfInjectDays: 99 }).selfInjectDays === 14, 'selfInjectDays 高于上限夹到 14')
  ok(normalizeConfig({ selfInjectChars: 1 }).selfInjectChars === 100, 'selfInjectChars 低于下限夹到 100')
  ok(normalizeConfig({ selfInjectChars: 99999 }).selfInjectChars === 2000, 'selfInjectChars 高于上限夹到 2000')
}

// 组合消息的纯函数写法也钉一下（不经过调度）
{
  const msg = composeSelfMessage({ situationEnabled: false }, '2026-11-20', 'C:\\x\\2026-11.md')
  ok(msg.includes('C:\\x\\2026-11.md') && msg.includes('## 2026-11-20'), 'composeSelfMessage：路径 + 格式')
  ok(!msg.includes('背景：'), 'situationEnabled=false 时不带背景行')
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
