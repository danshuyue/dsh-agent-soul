/**
 * S1 止血回归测试（2026-11-05）：node tests/s1-hotfix.test.js，退出码 0 = 全过。
 *
 * 钉住四条，每条都要求是「修之前必挂、修之后才过」的判据：
 *   ① P0-2 日记日期白名单：读面不能绕过 /diary/private 吐私密正文，写面不能覆盖人格文件
 *   ② P0-1 /config 不能再一次请求关掉回环边界（保留启动环境显式授权的逃生口）
 *   ③ P0-3 normalizeConfig 必须透传 DEFAULT_CONFIG 的全部键，三个静默失效的开关要真生效
 *   ④ P0-4 写盘失败：所有保存入口都不能对外报成功，且失败后内存缓存不许被清空
 *
 * ④ 特意写成「遍历所有入口」的清单式用例：B10 只补了主链路就漏掉 writeMemory，
 * 再单点补一个用例，下次换个调用点还会出 B11。
 *
 * 全程用临时 DSH_HOME，故障注入走 paths.__setAtomicWriteFailureForTest()，
 * 等价磁盘满 / 权限丢失，且不破坏已有文件（S3 起 tmp 名带 UUID，不再靠同名目录）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-s1-hotfix-'))
process.env.DSH_HOME = HOME
delete process.env.DSH_SOUL_ALLOW_REMOTE_API
// S2 起接口要带会话令牌；本文件用固定令牌模式，ephemeral 链路由 s2-hardening.test.js 覆盖。
process.env.DSH_SOUL_API_TOKEN = 'soul-s1-hotfix-test-token'

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
const memory = await import('../lib/memory.js')
const diary = await import('../lib/diary.js')
const { registerMemoryTool } = await import('../lib/tool.js')
const { registerApi, API_PREFIX } = await import('../lib/api.js')

// ---------------------------------------------------------------------------
// 假 HTTP：沿用 write-failure.test.js 的写法，只实现 handler 真正用到的部分
// ---------------------------------------------------------------------------
let handler = null
registerApi({
  webServer: {
    register: (spec) => {
      handler = spec.handler
      return () => {}
    }
  }
})
ok(typeof handler === 'function', 'API 路由注册成功')

function fakeReq(method, url, body) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: {
      host: '127.0.0.1:53397',
      'x-soul-token': process.env.DSH_SOUL_API_TOKEN
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
const call = async (method, path, body) => {
  const res = fakeRes()
  await handler(fakeReq(method, `${API_PREFIX}${path}`, body), res)
  let payload = {}
  try { payload = JSON.parse(res.result.body || '{}') } catch { /* 非 JSON 就当空 */ }
  return { status: res.result.status, payload, raw: res.result.body }
}

// ---------------------------------------------------------------------------
console.log('\n① P0-2 日记日期白名单：读面 / 写面 / 路径函数三层')
{
  eq(paths.isDiaryDateKey('2026-11-02'), true, '合法日期放行')
  const badDates = [
    '../private/2026-11-02',
    '../../../AGENT',
    '2026-11-02.md',
    '',
    '2026/11/02',
    '2026-11-02\n',
    20261102
  ]
  for (const bad of badDates) {
    eq(paths.isDiaryDateKey(bad), false, `非法日期被拒：${JSON.stringify(bad)}`)
  }
  let threw = 0
  for (const make of [
    () => paths.diaryPublicPath('../private/2026-11-02'),
    () => paths.diaryPrivatePath('../../../AGENT'),
    () => paths.diaryJsonlPath('../../x')
  ]) {
    try { make() } catch { threw += 1 }
  }
  eq(threw, 3, '三个路径函数对非法日期都抛错（不再悄悄拼出目录外的路径）')

  // 造公开 + 私密两篇，以及一个人格文件
  paths.ensureDirs()
  const publicFile = paths.diaryPublicPath('2026-11-02')
  const privateFile = paths.diaryPrivatePath('2026-11-02')
  const personaFile = paths.globalPersonaPath()
  writeFileSync(publicFile, '【公开】\n给树树看的正文\n', 'utf8')
  writeFileSync(privateFile, '【私密】\n只写给自己的秘密-SECRET-42\n', 'utf8')
  writeFileSync(personaFile, '人格原文-不要被覆盖', 'utf8')

  const bypass = await call('GET', '/diary/read?date=../private/2026-11-02')
  eq(bypass.status, 400, '公开读取口用 ../private/ 穿越 → 400')
  ok(bypass.raw.includes('SECRET-42') === false, '私密正文没有从 /diary/read 漏出来')
  const traverse = await call('GET', '/diary/read?date=../../../AGENT')
  eq(traverse.status, 400, '读人格文件 → 400')
  const normal = await call('GET', '/diary/read?date=2026-11-02')
  eq(normal.status, 200, '合法日期仍正常读')
  ok(String(normal.payload.publicContent ?? '').includes('给树树看的正文'), '合法日期读到公开正文')
  ok(normal.raw.includes('SECRET-42') === false, '合法读取也不带私密正文')
  const privateGate = await call('GET', '/diary/private?date=2026-11-02')
  eq(privateGate.status, 403, '/diary/private 这道门仍按开关拒绝（没有被改坏）')

  const writeAttack = await call('POST', '/diary', { date: '../../../AGENT', note: 'x' })
  eq(writeAttack.status, 400, 'POST /diary 穿越日期 → 400（不会进日记主流程）')
  eq(diary.writeDiaryFile('public', '../../../AGENT', '被覆盖了吗'), false, 'writeDiaryFile 直接调用也拒绝')
  eq(readFileSync(personaFile, 'utf8'), '人格原文-不要被覆盖', '人格文件原样未动')
  eq(diary.writeDiaryFile('public', '2026-11-03', '正常写一篇'), true, '合法日期仍能正常写')
  eq(existsSync(paths.diaryPublicPath('2026-11-03')), true, '合法日记落盘了')
}

// ---------------------------------------------------------------------------
console.log('\n② P0-1 /config 不能直接放宽回环边界（保留显式授权的逃生口）')
{
  const blocked = await call('POST', '/config', { apiLoopbackOnly: false })
  eq(blocked.status, 400, '默认环境下写 apiLoopbackOnly:false → 400')
  eq(blocked.payload.ok, false, 'body 明确失败')
  ok(store.loadConfig().apiLoopbackOnly !== false, '配置文件里边界没有被关掉')

  const ignored = await call('POST', '/config', { 不存在的键: 1, moodBase: 75 })
  eq(ignored.status, 200, '普通配置仍可保存')
  ok(!('不存在的键' in ignored.payload.config), '未知键仍被白名单丢掉')
  eq(ignored.payload.config.moodBase, 75, '合法键写入成功')

  process.env.DSH_SOUL_ALLOW_REMOTE_API = '1'
  const escaped = await call('POST', '/config', { apiLoopbackOnly: false })
  eq(escaped.status, 200, '启动环境显式授权后，设置页仍可自救')
  eq(escaped.payload.config.apiLoopbackOnly, false, '逃生口确实写进去了')
  delete process.env.DSH_SOUL_ALLOW_REMOTE_API
  store.saveConfig({ apiLoopbackOnly: true })
}

// ---------------------------------------------------------------------------
console.log('\n③ P0-3 normalizeConfig 透传全部配置键')
{
  const cfg = memory.normalizeConfig({
    projectMemoryEnabled: false,
    purposeEnabled: false,
    globalPromoteImportance: 90,
    autoImportanceEvent: 999,
    injectMaxChars: 'abc'
  })
  eq(cfg.projectMemoryEnabled, false, 'projectMemoryEnabled 不再丢')
  eq(cfg.purposeEnabled, false, 'purposeEnabled 不再丢')
  eq(cfg.globalPromoteImportance, 90, 'globalPromoteImportance 不再丢')
  eq(cfg.autoImportanceEvent, 100, '引擎键仍按原规则夹到 0~100（没被透传绕过）')
  eq(typeof cfg.injectMaxChars, 'number', '坏值仍回默认，没被透传成字符串')

  // 清单式：DEFAULT_CONFIG 的每个键都必须活着。以后加键忘了同步，这里立刻红。
  const all = memory.normalizeConfig({ ...store.DEFAULT_CONFIG })
  const missing = Object.keys(store.DEFAULT_CONFIG).filter((key) => !(key in all))
  const changed = Object.keys(store.DEFAULT_CONFIG).filter((key) => JSON.stringify(all[key]) !== JSON.stringify(store.DEFAULT_CONFIG[key]))
  eq(missing, [], `DEFAULT_CONFIG 的 ${Object.keys(store.DEFAULT_CONFIG).length} 个键全部透传`)
  eq(changed, [], '透传后值与默认值一致（归一没有悄悄改坏）')

  const poisoned = memory.normalizeConfig(JSON.parse('{"__proto__":{"polluted":1},"constructor":"x","prototype":"y"}'))
  ok(!('__proto__' in poisoned && poisoned.__proto__?.polluted === 1), '__proto__ 没被透传')
  eq({}.polluted, undefined, '全局对象没被污染')
  ok(!('constructor' in poisoned) || poisoned.constructor === Object, 'constructor 没被透传成自定义值')

  // 端到端：这是当初「改了配置不生效」的可观察现场
  const onlyGlobal = store.cardsFor('D:/some/project', { projectMemoryEnabled: false })
  eq(onlyGlobal.map((entry) => entry.scope), ['global'], '关掉项目记忆后 cardsFor 只返回全局卡')
  const both = store.cardsFor('D:/some/project', { projectMemoryEnabled: true })
  eq(both.map((entry) => entry.scope), ['global', 'project'], '打开时仍返回两张卡')
}

// ---------------------------------------------------------------------------
console.log('\n④ P0-4 写盘失败：所有保存入口都不许报成功')
{
  let def = null
  registerMemoryTool({ tools: { register: (d) => { def = d; return () => {} } } })
  ok(def !== null, 'soul_memory 工具注册成功')

  store.resetCaches()
  const seed = [
    '树树在烟台大学读机器人工程，关键词青鸟',
    '树树准备蓝桥杯嵌入式赛道，关键词朱雀',
    '树树在做新能源小车，关键词玄武'
  ]
  for (const text of seed) {
    const r = store.writeMemory({ scope: 'global', input: { text, source: 'test', isOwner: true, isPrivate: true } })
    eq(r.ok, true, `对照组写入成功：${text.slice(0, 12)}…`)
  }
  const cardFile = paths.globalMemoryPath()
  const diskCount = () => JSON.parse(readFileSync(cardFile, 'utf8')).records.length
  ok(diskCount() >= 3, `磁盘上确实有 3 条（实际 ${diskCount()}）`)
  const ids = store.globalCard().records.map((record) => record.id)

  // 故障注入：S3 给 tmp 名加了 randomUUID，原来「预建同名目录占住 tmp」的做法失效，
  // 改用 paths 提供的测试钩子直接让 atomicWrite 返回失败，语义仍是「磁盘写不进去」。
  paths.__setAtomicWriteFailureForTest(() => ({ ok: false, error: '模拟磁盘满（测试注入）' }))

  const entries = []
  const check = (name, result, okFlag) => {
    const good = okFlag === false
    ok(good, `${name} → 对外报失败${good ? '' : `（实际 ${JSON.stringify(result)}）`}`)
    entries.push(name)
  }

  // 所有会写记忆卡的入口，一个都不许漏
  const direct = store.saveGlobalCard(store.globalCard())
  check('store.saveGlobalCard（底层）', direct, direct?.ok)
  const viaStore = store.writeMemory({ scope: 'global', input: { text: '故障期间写的一条-甲', source: 'test' } })
  check('store.writeMemory', viaStore, viaStore?.ok)
  ok(String(viaStore.reason ?? '').includes('磁盘'), '失败原因说清楚了是磁盘写入')
  const toolWrite = await def.execute({ action: 'write', text: '故障期间写的一条-乙' }, {})
  check('soul_memory write', toolWrite, toolWrite?.ok)
  const toolRecall = await def.execute({ action: 'recall', query: '青鸟' }, {})
  check('soul_memory recall（刷新落盘）', toolRecall, toolRecall?.ok)
  const toolPin = await def.execute({ action: 'pin', id: ids[0] }, {})
  check('soul_memory pin', toolPin, toolPin?.ok)
  const toolForget = await def.execute({ action: 'forget', id: ids[2] }, {})
  check('soul_memory forget', toolForget, toolForget?.ok)
  const apiWrite = await call('POST', '/memory', { action: 'write', text: '故障期间写的一条-丙' })
  check('POST /memory', apiWrite, apiWrite.payload.ok)
  ok(apiWrite.status !== 200, `POST /memory 回非 200（实际 ${apiWrite.status}）`)

  // 强制让 maintain 真的产生一次写：把「上次衰减」推回很久以前
  store.globalCard().lastDecayDate = '2020-01-01'
  const report = store.maintain('', store.loadConfig())
  ok(Array.isArray(report.errors) && report.errors.length > 0, 'store.maintain 的 report.errors 报出写盘失败')
  entries.push('store.maintain')
  // 上一轮维护已经把清晰度降到底了，光改 lastDecayDate 不会再产生写；
  // 把一条记录拨回 forgotten，让这轮必然发生一次「恢复一档」的写入。
  const apiCard = store.globalCard()
  if (apiCard.records.length > 0) apiCard.records[0].clarity = 'forgotten'
  apiCard.lastDecayDate = '2020-01-01'
  const apiMaintain = await call('POST', '/maintain', {})
  ok(apiMaintain.status !== 200, `POST /maintain 回非 200（实际 ${apiMaintain.status}）`)
  entries.push('POST /maintain')
  eq(entries.length, 9, `清单覆盖 ${entries.length} 个保存入口（含底层）`)

  // 失败后不许「既不在盘也不在内存」：缓存必须保住这批改动
  const cached = store.globalCard()
  ok(cached.records.some((record) => record.text.includes('故障期间写的一条-甲')), '失败时缓存没被清空，改动仍可取回')
  eq(diskCount(), 3, '磁盘仍是故障前的 3 条（没有半截写、也没有假装成功）')

  // 恢复可写：同一条路必须重新成功，且把攒下的改动一起落盘
  paths.__setAtomicWriteFailureForTest(null)
  const recovered = store.writeMemory({ scope: 'global', input: { text: '恢复后写的一条', source: 'test' } })
  eq(recovered.ok, true, '恢复后 writeMemory 重新成功')
  ok(diskCount() > 3, '恢复后新记录真的落盘了')
}

// ---------------------------------------------------------------------------
console.log('\n收尾：')
{
  rmSync(HOME, { recursive: true, force: true })
  ok(existsSync(HOME) === false, '临时目录已清理')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
