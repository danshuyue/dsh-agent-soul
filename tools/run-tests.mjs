/**
 * 全量测试收集器（2026-11-06 重构 P0）。
 *
 * 原来 npm test 是 51 条 `node tests/xxx.test.js` 的手工长串，靠
 * suite-manifest.test.js 用正则比对防漂移 —— 新增一个文件忘了登记就永远不跑。
 * 现在改成递归收集 + 逐文件**串行**执行。
 *
 * 为什么串行、不用 `node --test` 自动并发：仓库里 40 个自建 runner 与 9 个
 * node:test 用例并存，很多用例各自 mkdtemp 同一个 DSH_HOME 布局，并发会互相踩
 * 临时目录。这里只统一「调度层」，文件内部用哪种断言框架都照旧单进程跑。
 *
 * 收集函数导出给 suite-manifest.test.js 做门禁比对，避免两套清单再次漂移。
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = join(projectRoot, 'tests')

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.name.endsWith('.test.js') ? [full] : []
  })
}

/** @returns {string[]} 相对项目根的路径，统一用 / 分隔，按字典序 */
export function collectTests() {
  return walk(testsDir)
    .map((f) => relative(projectRoot, f).replace(/\\/g, '/'))
    .sort()
}

function main() {
  // --only=<路径片段>：只跑子集（CI 用来单独跑契约门禁）。
  // 过滤只作用于调度层，collectTests() 本身不变，suite-manifest 的清单门禁不受影响。
  const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length)
  const all = collectTests()
  const files = only === '' ? all : all.filter((f) => f.includes(only))
  if (files.length === 0) {
    console.error(`没有收集到任何 .test.js${only ? `（--only=${only}）` : ''}`)
    process.exit(1)
  }
  console.log(`收集到 ${files.length} 个测试文件${only ? `（--only=${only}，全量 ${all.length}）` : ''}，串行执行\n`)
  let executed = 0
  let failed = 0
  for (const rel of files) {
    executed += 1
    console.log(`\n===== [${executed}/${files.length}] ${rel} =====`)
    const result = spawnSync(process.execPath, [join(projectRoot, rel)], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit'
    })
    if (result.error) {
      console.error(`✗ ${rel} 启动失败：${result.error.message}`)
      failed += 1
      break
    }
    if (result.status !== 0) {
      console.error(`\n✗ ${rel} 退出码 ${result.status}，停止后续测试`)
      failed += 1
      break
    }
  }
  console.log(`\n汇总：收集 ${files.length} / 执行 ${executed} / 失败 ${failed}`)
  process.exit(failed === 0 && executed === files.length ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
