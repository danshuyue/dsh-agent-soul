/**
 * 归档分片回归（2026-11-06 P12）。
 *
 * 验证三件事：
 *   ① archiveMaxBytes 默认 0 → 完全不走新代码，升级后零行为变化；
 *   ② 显式开启后只「另存为分片」，绝不删除任何文件；
 *   ③ 分片后 recallArchived 仍能查回旧记录（不破「忘了也能查回来」的承诺）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = mkdtempSync(join(tmpdir(), 'soul-archive-rotate-'))
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

const NOW = Date.parse('2026-11-06T12:00:00Z')
const lines = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({
  archivedAt: new Date(NOW + i * 1000).toISOString(),
  reason: 'decay',
  record: { id: `r${i}`, text: `归档记录 ${i} 关于树树的 STM32` }
})).join('\n') + '\n'

try {
  const { rotateArchiveIfNeeded } = await imp('retention.js')
  const { archivePath } = await imp('paths.js')
  const { recallArchived } = await imp('memory.js')
  const store = await imp('store.js')
  const { normalizeConfig } = await imp('memory.js')

  const file = archivePath()
  mkdirSync(dirname(file), { recursive: true })

  console.log('\n① 默认关闭：一个文件都不动')
  eq(store.DEFAULT_CONFIG.archiveMaxBytes, 0, 'DEFAULT_CONFIG.archiveMaxBytes 默认 0')
  eq(normalizeConfig({ archiveMaxBytes: 123 }).archiveMaxBytes, 123, '显式值能透传（P0-3 修复仍生效）')
  writeFileSync(file, lines(30), 'utf8')
  const before = readFileSync(file, 'utf8')
  const skipped = rotateArchiveIfNeeded(file, 0, { now: NOW })
  eq(skipped.skipped, true, 'maxBytes=0 直接跳过')
  eq(skipped.rotated, false, '没有分片')
  eq(readFileSync(file, 'utf8'), before, '文件内容逐字节不变')
  eq(readdirSync(dirname(file)).filter((n) => n.startsWith('archive.jsonl.')).length, 0, '没有生成任何分片')

  console.log('\n② 未达阈值不动；超阈值只另存、不删')
  eq(rotateArchiveIfNeeded(file, 1024 * 1024, { now: NOW }).rotated, false, '未达阈值不触发')
  const first = rotateArchiveIfNeeded(file, 100, { now: NOW })
  eq(first.rotated, true, '超过 100 字节触发分片')
  ok(existsSync(first.to), '分片文件存在')
  eq(readFileSync(first.to, 'utf8'), before, '旧内容完整保留在分片里')
  eq(existsSync(file), false, '主文件已被移走（下次 append 会新建）')
  eq(rotateArchiveIfNeeded(file, 100, { now: NOW }).reason, 'missing', '主文件不存在时安全返回')

  console.log('\n③ 查回能力不因分片丢失')
  const found = recallArchived(file, 'STM32', { limit: 50 })
  eq(found.length, 30, '分片里的 30 条记录全部能查回')
  ok(found.some((x) => String(x?.record?.text).includes('归档记录 0')), '最旧那条也在')

  console.log('\n④ 同名分片不覆盖')
  writeFileSync(file, lines(5), 'utf8')
  const second = rotateArchiveIfNeeded(file, 100, { now: NOW })
  eq(second.rotated, true, '同一毫秒再次触发也能分片')
  ok(second.to !== first.to, '新分片用了不同名字，没覆盖旧的')
  ok(existsSync(first.to) && existsSync(second.to), '两份分片都还在（没有删任何文件）')
  eq(recallArchived(file, 'STM32', { limit: 60 }).length, 35, '两份分片 + 查回总数正确')
} catch (error) {
  failed += 1
  console.error(`  ✗ 归档分片测试抛异常：${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
} finally {
  rmSync(HOME, { recursive: true, force: true })
  console.log('\n收尾：')
  ok(!existsSync(HOME), '临时 DSH_HOME 已清理')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
