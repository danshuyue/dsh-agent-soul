/**
 * 契约回归 · 写盘失败不能报成功（2026-11-06 P10 从 _review-tmp 探针固化）
 *
 * 这是 2026-11-05「半修 bug」的正条：writeMemory 压根没接 saveCard 的结果，
 * 工具照回「记住了」，缓存又被无条件清掉 —— 记录同时不在磁盘和内存。
 * 原探针只打印结论，这里改成真断言；把 store.js 改回去就会红。
 *
 * 故障注入用 paths.__setAtomicWriteFailureForTest（S3 起 tmp 名带 UUID，
 * 早期「预建同名目录」的做法已失效），等价磁盘满 / 权限丢失，不破坏已有数据。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'soul-probe-write-'))
process.env.DSH_HOME = HOME

const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

try {
  mkdirSync(join(HOME, 'agents', 'memory'), { recursive: true })
  const store = await imp('store.js')
  const { registerMemoryTool } = await imp('tool.js')
  const { globalMemoryPath, __setAtomicWriteFailureForTest } = await imp('paths.js')

  const file = globalMemoryPath()
  const diskCount = () => {
    if (!existsSync(file)) return 0
    return JSON.parse(readFileSync(file, 'utf8')).records.length
  }

  let def = null
  registerMemoryTool({ tools: { register: (d) => { def = d; return () => {} } } })
  ok(typeof def?.execute === 'function', 'soul_memory 工具注册成功')

  console.log('\n① 对照组：正常写入必须落盘')
  const normal = await def.execute({ action: 'write', text: '对照组：一条正常的记忆' }, {})
  eq(normal.ok, true, '工具回 ok:true')
  eq(diskCount(), 1, '磁盘上有 1 条记录')

  console.log('\n② 注入写盘失败（模拟磁盘满 / 权限丢失）')
  __setAtomicWriteFailureForTest(() => ({ ok: false, error: '模拟磁盘满（探针注入）' }))
  eq(existsSync(file), true, '已有记忆卡未被破坏')
  eq(diskCount(), 1, '注入前盘上仍是 1 条')

  const direct = store.saveGlobalCard(store.globalCard())
  eq(direct.ok, false, '底层 saveGlobalCard 能看见失败')
  ok(String(direct.error).includes('模拟磁盘满'), '失败原因带得回来')

  console.log('\n③ 对外链路不能骗调用方（P0-4）')
  const text = '写盘失败时这条绝不能被报成「记住了」'
  const viaStore = store.writeMemory({ scope: 'global', input: { text, source: 'probe', isOwner: true, isPrivate: true } })
  eq(viaStore.ok, false, '★ writeMemory 回 ok:false')
  const viaTool = await def.execute({ action: 'write', text: text + '（工具层）' }, {})
  eq(viaTool.ok, false, '★ soul_memory 工具回 ok:false（不再说「记住了」）')

  console.log('\n④ 数据既不能丢、也不能被半截写污染')
  eq(diskCount(), 1, '磁盘记录数仍是 1（两次失败写入都没落盘）')
  const fresh = store.globalCard()
  ok(fresh.records.length >= 2, `缓存保住了改动（现有 ${fresh.records.length} 条，≥2）`)
  ok(fresh.records.some((r) => String(r.text).includes('写盘失败时这条')), '缓存里能找到刚写的第二条')

  console.log('\n⑤ 恢复后可重试')
  __setAtomicWriteFailureForTest(null)
  const retried = store.saveGlobalCard(store.globalCard())
  eq(retried.ok, true, '恢复后写盘成功')
  ok(diskCount() >= 2, '攒下的改动最终落盘')
} catch (error) {
  failed += 1
  console.error(`  ✗ 探针执行抛异常：${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
} finally {
  const { __setAtomicWriteFailureForTest } = await imp('paths.js')
  __setAtomicWriteFailureForTest(null)
  rmSync(HOME, { recursive: true, force: true })
  console.log('\n收尾：')
  ok(!existsSync(HOME), '临时 DSH_HOME 已清理')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
