/**
 * R17 · diary/deliver 特征测试（2026-11-10，#26 拆分前置）
 *
 * scheduler.js 拆分前，投递块里只有 shouldAskAgain **零直接覆盖**；
 * askAgentToWrite 的主链路（成功/超时兜底/并发锁）已由 diary-tool.test.js
 * 端到端覆盖，diaryAgent 由 diary.test.js「专属日记会话」一节覆盖 ——
 * 本文件补的是拆分会动到的两块的缺口：
 *   ① shouldAskAgain 判定矩阵（force / 不存在 / since=0 老行为 / 旧文件 / 新文件）
 *   ② since 语义经 runDiaryOnce 的端到端：文件在但比 since 旧 → 重新找她写
 *     （R05 / P1-D3 修的「看门狗 30 分钟空转」那条）
 * 拆完这份测试必须一条不改就全绿（R15/R16 纪律照抄）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r17-'))
process.env.DSH_HOME = sandbox
process.env.TZ = 'UTC'
mkdirSync(join(sandbox, 'agents'), { recursive: true })

let passed = 0
let failed = 0
const ok = (c, n) => { if (c) { passed += 1; console.log(`  ✓ ${n}`) } else { failed += 1; console.error(`  ✗ ${n}`) } }
const eq = (a, e, n) => ok(JSON.stringify(a) === JSON.stringify(e), `${n}${JSON.stringify(a) === JSON.stringify(e) ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(e)}）`}`)

const { ensureDirs, diaryPublicPath, diaryPrivatePath } = await imp('paths.js')
ensureDirs()
const diary = await imp('diary.js')
// shouldAskAgain 现住 scheduler.js；#27/#26 拆分后迁往 diary/deliver.js（届时只改这一行 import）
const { shouldAskAgain } = await imp('diary/scheduler.js')
const { runDiaryOnce } = diary
const { writeDiaryFile } = await imp('diary/files.js')
const store = await imp('store.js')

// ---------------------------------------------------------------------------
console.log('① shouldAskAgain 判定矩阵')
// ---------------------------------------------------------------------------
{
  const file = join(sandbox, 'r17-ask.txt')
  writeFileSync(file, 'x', 'utf8')
  const mtime = statSync(file).mtimeMs

  eq(shouldAskAgain(file, { force: true }), true, 'force=true → 一定重写（无视一切）')
  eq(shouldAskAgain(join(sandbox, '不存在.md'), {}), true, '文件不存在 → 要写')
  eq(shouldAskAgain(file, { since: 0 }), false, '存在 + since=0 → 当她已写过（老行为，P1-D3 前的口径）')
  eq(shouldAskAgain(file, { since: mtime + 5000 }), true, '存在 + 比 since 旧 → 是上一轮的旧文件，重写')
  eq(shouldAskAgain(file, { since: mtime - 5000 }), false, '存在 + 比 since 新 → 她这轮写的，不重问')
  utimesSync(file, new Date(mtime - 10_000), new Date(mtime - 10_000))
  eq(shouldAskAgain(file, { since: Date.now() }), true, 'mtime 被拨老 + since=now → 重写（宁可多问一次）')
}

// ---------------------------------------------------------------------------
console.log('② since 语义端到端：文件在但比 since 旧 → 重新找她写（不走兜底生成）')
// ---------------------------------------------------------------------------
{
  const date = '2026-11-01'
  // 先「写好」两篇（mtime = 现在）
  writeDiaryFile('public', date, '下午手动补的半成品公开日记')
  writeDiaryFile('private', date, '下午手动补的半成品私密日记')
  store.saveConfig({ diarySessionId: 'sess-r17', diaryAgentWrite: true, diaryAgentTimeoutMs: 600 })

  const asked = []
  const fakeAgent = {
    followup: (message) => {
      asked.push(String(message?.source?.kind ?? ''))
      const text = String(message?.content?.[0]?.text ?? '')
      // 收到消息后同步重写文件（mtime 变新 → waitForWrite 立即认）
      if (text.includes('kind=public')) writeDiaryFile('public', date, '她重写的公开日记')
      else if (text.includes('kind=private')) writeDiaryFile('private', date, '她重写的私密日记')
    }
  }
  const ctx = {
    agents: { get: (id) => (id === 'sess-r17' ? fakeAgent : undefined) },
    llm: { stream: async function* () { throw new Error('不该兜底：她自己重写了') } }
  }

  // since = 未来 5 秒：现有文件必然「比 since 旧」→ 判定为旧文件，重新问她
  const since = Date.now() + 5000
  const done = await runDiaryOnce(ctx, date, undefined, { since })
  eq(done, true, '整体成功')
  eq(asked.length, 2, '两篇都被重新投递（旧文件不被当成「她写好了」——P1-D3 死循环的判据）')
  eq(asked.every((k) => k === 'schedule'), true, '重投的 source.kind 仍是 schedule')
  ok(existsSync(diaryPublicPath(date)), '公开篇文件在')
  ok(readFileSync(diaryPrivatePath(date), 'utf8').includes('她重写的私密日记'), '私密篇是她重写的那版')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
