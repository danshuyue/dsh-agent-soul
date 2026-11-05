/**
 * sync.mjs —— 把源码同步到 DSH 插件目录（原子写，不会读到半截文件）。
 *
 * ── 为什么需要它 ──
 * 2026-10-28 真事故：用 `cp` 覆盖 client.js 时，DSH 正好在启动读取它，
 * 读到了写了一半的文件，日志里只有一句
 *
 *   web boot: 1 entry did not activate
 *   dsh-agent-soul: bundle script ... failed to load
 *
 * 整个桌面应用起不来。代码本身没问题，纯粹是复制和读取撞在了一起。
 *
 * 所以这里改成了「先写 .tmp，再 rename」：同一分区上 rename 是原子的，
 * 读的人要么看到旧版、要么看到新版，不会看到半截。
 *
 * ── 用法 ──
 *   node tools/sync.mjs                 同步到 <DSH_HOME>/plugins/dsh-agent-soul
 *   node tools/sync.mjs --to <目录>      指定目标
 *   node tools/sync.mjs --dry           只看会改什么，不真写
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dry = argv.includes('--dry')
const toIndex = argv.indexOf('--to')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const DEST = toIndex >= 0 && argv[toIndex + 1] ? resolve(argv[toIndex + 1]) : join(dshHome, 'plugins', 'dsh-agent-soul')

/** 同步的项：目录整份同步，文件单个同步。 */
// assets 是心情那五张表情图（PNG），lib/api.js 直接从这里读出去给设置页
const DIRS = ['lib', 'tests', 'docs', 'assets']
const FILES = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']

/**
 * 原子复制：先落到同目录的 .tmp-<pid>-<uuid>，再 rename 覆盖。
 * rename 在同一分区是原子操作，读的人不会看到半截内容。
 * 2026-11-05 S3：tmp 名加 UUID，避免同进程连续同步互相踩残留。
 */
function atomicCopy(from, to) {
  const tmp = `${to}.tmp-${process.pid}-${randomUUID()}`
  copyFileSync(from, tmp)
  renameSync(tmp, to)
}

/**
 * 递归同步一个目录。
 *
 * 2026-11-04 修：原来这里只处理**第一层文件**（`if (!statSync(...).isFile()) continue`
 * 把子目录整个跳过了）。于是 `lib/client/` 那一堆前端片段从来没有被同步过 ——
 * 运行时靠的是打包产物 `lib/client.js`（在 lib 顶层，所以功能看起来没问题），
 * 但源码副本一直是旧的，改完 `client/xxx.js` 查副本会以为没保存。
 * 这个坑踩了两次，直接改成递归。
 */
function syncDir(name) {
  const from = join(SRC, name)
  if (!existsSync(from)) return { added: 0, updated: 0 }
  const to = join(DEST, name)
  if (!dry) mkdirSync(to, { recursive: true })

  let added = 0
  let updated = 0

  const walk = (srcDir, dstDir) => {
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = join(srcDir, entry.name)
      const dstPath = join(dstDir, entry.name)
      if (entry.isDirectory()) {
        if (!dry) mkdirSync(dstPath, { recursive: true })
        walk(srcPath, dstPath)
        continue
      }
      if (!entry.isFile()) continue
      const existed = existsSync(dstPath)
      if (!dry) atomicCopy(srcPath, dstPath)
      if (existed) updated += 1
      else added += 1
    }
  }

  walk(from, to)
  return { added, updated }
}

function syncFile(name) {
  const from = join(SRC, name)
  if (!existsSync(from)) return null
  const dstFile = join(DEST, name)
  const existed = existsSync(dstFile)
  if (!dry) atomicCopy(from, dstFile)
  return { added: existed ? 0 : 1, updated: existed ? 1 : 0 }
}

// ---- 主流程 ----

if (!existsSync(DEST) && !dry) {
  console.error(`目标目录不存在：${DEST}`)
  console.error('第一次安装请先手动建目录并在 profile 里登记，参考 README「安装」。')
  process.exit(1)
}

console.log(`源：${SRC}`)
console.log(`目标：${DEST}${dry ? '（--dry，只看不改）' : ''}`)
console.log('')

let added = 0
let updated = 0
for (const dir of DIRS) {
  const result = syncDir(dir)
  added += result.added
  updated += result.updated
  if (result.added + result.updated > 0) {
    console.log(`  ${dir}/  新增 ${result.added}，更新 ${result.updated}`)
  }
}
for (const file of FILES) {
  const result = syncFile(file)
  if (result === null) {
    console.log(`  ${file}  源码里没有，跳过`)
    continue
  }
  added += result.added
  updated += result.updated
}

// 清理上次中断留下的 .tmp（只清自己这套命名）
// 2026-11-05 修 P1-8：原来这段**没有 if (!dry)** —— `--dry` 会真的 rmSync，
// 随后还打印「什么都没改」。预览生产宿主目录时这就是一次误删。
// 顺手改成递归扫描：atomicCopy 现在会往 lib/client/ 这类子目录写，
// 只扫第一层根本清不到残留。
let staleCount = 0
let removedCount = 0
const TMP_RE = /\.tmp-\d+(?:-[0-9a-f-]+)?$/i
function cleanTmp(dir, rel = '') {
  const target = join(DEST, dir, rel)
  if (!existsSync(target)) return
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const full = join(target, entry.name)
    if (entry.isDirectory()) {
      cleanTmp(dir, join(rel, entry.name))
      continue
    }
    if (!TMP_RE.test(entry.name)) continue
    staleCount += 1
    if (dry) continue
    rmSync(full, { force: true })
    removedCount += 1
    console.log(`  清掉残留临时文件 ${join(dir, rel, entry.name)}`)
  }
}
try {
  for (const dir of DIRS) cleanTmp(dir)
} catch (error) {
  console.error(`  ⚠️ 清理临时文件失败（不影响同步结果）：${error instanceof Error ? error.message : String(error)}`)
}

console.log('')
console.log(dry
  ? `（dry run 结束，什么都没改；发现 ${staleCount} 个残留临时文件，未删除）`
  : `同步完成：新增 ${added}，更新 ${updated} 个文件，清掉 ${removedCount} 个残留临时文件`)
if (!dry) {
  console.log('')
  console.log('⚠️  改动要重启 DSH（或刷新页面加载 client.js）才生效。')
  console.log('   重启前确认没有正在进行的同步 —— 这个脚本已经是原子写，不会再读到半截文件。')
}
