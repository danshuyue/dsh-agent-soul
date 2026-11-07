/**
 * R05 · 日记状态机三件（P1-D4 / P1-D3 / P1-D2）
 *
 * 这三条是一条事故链上的三处，必须一起测：
 *   ① 判定「那一天写完没有」时，只看了对话记录末尾 80 行（D4）；
 *   ② 判完不完整、决定重写，但「文件在 = 她写好了」的旧判断把重写顶回去（D3）；
 *   ③ 兜底写盘不看 mtime，她晚几秒落盘就被整篇覆盖（D2）。
 *
 * 全部用真实文件 + 真实 mtime，不 mock 文件系统 —— 这三条本来就是文件状态问题。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r05-diary-'))
process.env.DSH_HOME = sandbox
process.env.TZ = 'UTC'
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
const completion = await imp('diary/completion.js')
const files = await imp('diary/files.js')
const scheduler = await imp('diary/scheduler.js')
const paths = await imp('paths.js')

const DATE = '2026-11-05'
const start = completion.parseDateLocal(DATE).getTime()
const end = start + 24 * 3600 * 1000

/** 把某文件的 mtime 设成指定毫秒 */
function setMtime(file, ms) {
  const sec = ms / 1000
  utimesSync(file, sec, sec)
}

// ---------------------------------------------------------------------------
console.log('D4 · 判「最后说话时间」要扫整份，不是末尾 80 行')
// ---------------------------------------------------------------------------
{
  // 造一份「最后一句在前部、末尾全是更早的」的 JSONL —— 多会话交错 + late flush 的形态
  const lines = []
  for (let i = 0; i < 20; i += 1) {
    lines.push(JSON.stringify({ t: end - 60_000, text: `很晚的一句 ${i}` }))
  }
  for (let i = 0; i < 120; i += 1) {
    lines.push(JSON.stringify({ t: start + 3600_000, text: `很早的一句 ${i}` }))
  }
  writeFileSync(paths.diaryJsonlPath(DATE), `${lines.join('\n')}\n`, 'utf8')

  // 日记写在 02:00（早于「很晚的一句」）
  const writtenAt = start + 2 * 3600_000
  for (const p of [paths.diaryPublicPath(DATE), paths.diaryPrivatePath(DATE)]) {
    writeFileSync(p, '【公开】\n2026-11-05\n\n半成品正文\n', 'utf8')
    setMtime(p, writtenAt)
  }

  eq(completion.diaryIsCompleteFor(DATE), false,
    '最后一句在末尾 80 行之外时仍判「不完整」（旧实现会误判完整）')
}

// ---------------------------------------------------------------------------
console.log('D3 · 「文件在 = 她写好了」要加时间基线')
// ---------------------------------------------------------------------------
{
  const pub = paths.diaryPublicPath(DATE)
  const old = start + 2 * 3600_000
  setMtime(pub, old)

  eq(scheduler.shouldAskAgain(pub, { since: 0 }), false,
    'since=0（老调用方）→ 仍然认为她已经写过（保持旧行为，不误打扰）')
  eq(scheduler.shouldAskAgain(pub, { since: old + 60_000 }), true,
    '文件比本轮基线旧 → 要重新问她（旧实现这里是 false，于是永远补不出来）')
  eq(scheduler.shouldAskAgain(pub, { since: old - 60_000 }), false,
    '文件比本轮基线新（她刚写完）→ 不再打扰')
  eq(scheduler.shouldAskAgain(pub, { force: true, since: old + 60_000 }), true,
    'force（手动重写）→ 一定重新写')
  eq(scheduler.shouldAskAgain(join(sandbox, 'never-existed.md'), { since: Date.now() }), true,
    '文件不存在 → 要写')

  // mtime 读不到（用目录冒充文件会让 stat 成功但…这里直接删掉它）
  rmSync(pub, { force: true })
  eq(scheduler.shouldAskAgain(pub, { since: Date.now() }), true, '文件被删 → 要写')
}

// ---------------------------------------------------------------------------
console.log('D2 · 兜底写盘前要避让她刚写好的那份')
// ---------------------------------------------------------------------------
{
  const pub = paths.diaryPublicPath(DATE)
  const herText = '【公开】\n2026-11-05\n\n她自己已经写好的正文（不该被覆盖）\n'
  writeFileSync(pub, herText, 'utf8')
  const herMtime = Date.now()
  setMtime(pub, herMtime)

  // 兜底基线比她的 mtime 早 → 说明她是在我们「问她」之后才落盘的 → 兜底必须让路
  const skipped = files.writeDiaryFile('public', DATE, '插件兜底生成的正文', { skipIfNewerThan: herMtime - 5000 })
  eq(skipped, false, '兜底让路：返回 false（不是假装写成功）')
  eq(readFileSync(pub, 'utf8'), herText, '她的正文一个字都没被改')

  // 兜底基线比她的 mtime 晚（文件是上一轮留下的旧文件）→ 正常覆盖
  const written = files.writeDiaryFile('public', DATE, '插件兜底生成的正文', { skipIfNewerThan: herMtime + 5000 })
  eq(written, true, '旧文件仍然可以被兜底覆盖（不把正常路径也堵死）')
  ok(readFileSync(pub, 'utf8').includes('插件兜底生成的正文'), '覆盖确实发生了')

  // 不带选项（老的调用方：diary-tool）→ 行为不变
  const plain = files.writeDiaryFile('public', DATE, '第三个版本')
  eq(plain, true, '不传 skipIfNewerThan 时行为不变')
  ok(readFileSync(pub, 'utf8').includes('第三个版本'), '老调用方照常覆盖')
}

// ---------------------------------------------------------------------------
console.log('D2/D3 组合 · 「她要晚写」时启动流程不会把她覆盖成兜底版')
// ---------------------------------------------------------------------------
{
  // 场景复刻：旧文件存在（下午的半成品）+ 本轮决定重写 + 她在兜底前落盘。
  // 这里只验证最后一步（兜底让路）不会毁掉她的产出 —— 启动流程整体在 r02-diary-budget 里跑过。
  const pub = paths.diaryPublicPath(DATE)
  const herLate = '【公开】\n2026-11-05\n\n她迟到写出的完整版\n'
  writeFileSync(pub, herLate, 'utf8')
  const late = Date.now()
  setMtime(pub, late)
  const okWrite = files.writeDiaryFile('public', DATE, '兜底版（不该出现）', { skipIfNewerThan: late - 1000 })
  eq(okWrite, false, '兜底被挡下')
  ok(!readFileSync(pub, 'utf8').includes('兜底版'), '盘上是她的版本')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
