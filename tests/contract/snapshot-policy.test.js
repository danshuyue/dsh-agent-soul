/**
 * 契约门禁 ⑥：快照变更策略（2026-11-06 P11）。
 *
 * 用真行为验证「刷基线消红」被挡住：带 SOUL_UPDATE_SNAPSHOT=1 但不给理由，
 * 两个快照测试都必须非零退出，且快照文件一字节不变。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHANGELOG, changelogPath } from './snapshot-policy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'soul-snapshot-policy-'))

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

const snapshots = ['exports.snapshot.json', 'behavior-golden.json'].map((f) => join(root, 'tests', 'contract', f))
const digest = () => snapshots.map((f) => createHash('sha256').update(readFileSync(f, 'utf8')).digest('hex'))

try {
  console.log('\n① 策略文件与运行环境')
  ok(existsSync(changelogPath(root)), `${CHANGELOG} 存在（变更理由留痕处）`)
  ok(readFileSync(changelogPath(root), 'utf8').includes('SOUL_SNAPSHOT_REASON'), '变更记录里写明了理由的用法')
  ok(process.env.SOUL_UPDATE_SNAPSHOT !== '1', '全量测试不允许带 SOUL_UPDATE_SNAPSHOT=1 跑')
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  ok(ci.includes('tests/contract/'), 'CI 会检查契约目录没被测试改写')

  console.log('\n② 不带理由更新快照必须失败（真跑子进程）')
  const before = digest()
  for (const testFile of ['exports.snapshot.test.js', 'behavior-golden.test.js']) {
    const child = spawnSync(process.execPath, [join(root, 'tests', 'contract', testFile)], {
      cwd: root,
      env: { ...process.env, DSH_HOME: HOME, SOUL_UPDATE_SNAPSHOT: '1', SOUL_SNAPSHOT_REASON: '' },
      encoding: 'utf8'
    })
    const output = `${String(child.stdout ?? '')}${String(child.stderr ?? '')}`
    ok(child.status !== 0, `${testFile} 缺理由时非零退出（实际 ${child.status}）`)
    ok(output.includes('必须写明理由'), `${testFile} 给出了可操作的提示`)
  }
  eq(digest(), before, '两次失败尝试都没改写快照文件')
} catch (error) {
  failed += 1
  console.error(`  ✗ 策略检查抛异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  rmSync(HOME, { recursive: true, force: true })
  console.log('\n收尾：')
  ok(!existsSync(HOME), '临时 DSH_HOME 已清理')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
