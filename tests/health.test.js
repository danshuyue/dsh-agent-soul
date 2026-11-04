/**
 * 每日健康一行（2026-11-04）。
 *
 * 三个必须成立的约定：
 *   ① 同一天调两次只写一行（maintain 每回合都可能被摸到，不能刷屏）
 *   ② 跨天会再写一行（进程一直开着也不能漏）
 *   ③ 某一项取不到时整行仍然写出，那项是 `-`（不能因为统计失败就没有健康行）
 * 另外测一下各字段的数对不对：归档行数、笔记篇数、日记最近一天。
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { ensureDirs, healthStatePath, archivePath, notesIndexPath, diaryPublicDir, diaryPrivateDir } from '../lib/paths.js'
import { writeDailyHealth, renderHealthLine, __resetRefinePendingForTest } from '../lib/health.js'

let HOME = ''

/** 每个用例一个独立的 DSH_HOME：路径函数每次调用都重新读环境变量，不用重载模块。 */
function setupHome() {
  HOME = mkdtempSync(join(tmpdir(), 'soul-health-test-'))
  process.env.DSH_HOME = HOME
  ensureDirs()
  __resetRefinePendingForTest()
  return HOME
}

function logLines() {
  const file = join(HOME, 'agents', 'soul.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
}

function healthLines() {
  return logLines().filter((line) => line.startsWith('[health]'))
}

const DAY4 = new Date(2026, 10, 4, 12, 0, 0).getTime()
const DAY5 = new Date(2026, 10, 5, 12, 0, 0).getTime()

function fakeCards() {
  return {
    global: {
      records: [
        { id: 'a', text: '固定的一条', clarity: 'vivid', pinned: true, importance: 60, tags: [] },
        { id: 'b', text: '关于树树的长期事实', clarity: 'clear', pinned: false, importance: 50, tags: ['owner', 'fact'] },
        { id: 'c', text: '有点模糊了', clarity: 'fuzzy', pinned: false, importance: 40, tags: [] },
        { id: 'd', text: '只剩印象', clarity: 'trace', pinned: false, importance: 30, tags: [] }
      ],
      stats: { forgotten: 2 }
    },
    project: {
      records: [
        { id: 'e', text: '项目里的一条', clarity: 'clear', pinned: false, importance: 40, tags: [] }
      ],
      stats: { forgotten: 0 }
    }
  }
}

afterEach(() => {
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* 临时目录删不掉不影响断言 */
  }
})

describe('每日健康一行', () => {
  test('同一天调两次只写一行', () => {
    setupHome()
    const first = writeDailyHealth({ cwd: 'D:\\work', config: {}, cards: fakeCards(), now: DAY4 })
    const second = writeDailyHealth({ cwd: 'D:\\work', config: {}, cards: fakeCards(), now: DAY4 })
    assert.equal(first.written, true)
    assert.equal(second.written, false)
    assert.equal(healthLines().length, 1)
  })

  test('跨天会再写一行，状态文件记的是当天日期', () => {
    setupHome()
    writeDailyHealth({ cwd: '', config: {}, cards: fakeCards(), now: DAY4 })
    const next = writeDailyHealth({ cwd: '', config: {}, cards: fakeCards(), now: DAY5 })
    assert.equal(next.written, true)
    assert.equal(healthLines().length, 2)

    const state = JSON.parse(readFileSync(healthStatePath(), 'utf8'))
    assert.deepEqual(state, { lastDate: '2026-11-05' })
  })

  test('某项抛错时整行仍写出，那项为 -', () => {
    setupHome()
    const broken = {
      global: {
        get records() {
          throw new Error('模拟记忆卡读坏')
        },
        stats: {}
      },
      project: null
    }
    let result = null
    assert.doesNotThrow(() => {
      result = writeDailyHealth({ cwd: '', config: {}, cards: broken, now: DAY4 })
    })
    assert.equal(result.written, true)
    const lines = healthLines()
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^\[health\] /)
    assert.match(lines[0], /记忆 -/)
    // 其他项不受牵连，照常有数
    assert.match(lines[0], /归档 0 条/)
    assert.match(lines[0], /笔记 0 篇/)
    assert.match(lines[0], /写盘失败 0/)
    assert.match(lines[0], /提炼队列 0/)
  })

  test('各项数字取自真实文件：归档行数、笔记篇数、日记最近一天', () => {
    setupHome()
    // 归档：3 行（最后一行故意不带换行，验证也数得进去）
    mkdirSync(dirname(archivePath()), { recursive: true })
    writeFileSync(archivePath(), '{"a":1}\n{"a":2}\n{"a":3}', 'utf8')
    // 笔记索引：2 篇
    writeFileSync(notesIndexPath(), JSON.stringify({ version: 1, notes: [{ slug: 'x' }, { slug: 'y' }] }), 'utf8')
    // 日记：昨天那篇（窗口早过了，mtime 也很早 → 判为「缺」而不是「完整」）
    mkdirSync(diaryPublicDir(), { recursive: true })
    mkdirSync(diaryPrivateDir(), { recursive: true })
    writeFileSync(join(diaryPublicDir(), '2026-11-02.md'), '公开', 'utf8')
    writeFileSync(join(diaryPrivateDir(), '2026-11-02.md'), '私密', 'utf8')
    // 更早的一篇：最近一天必须取最大的
    writeFileSync(join(diaryPrivateDir(), '2026-10-31.md'), '更早', 'utf8')
    // 把 mtime 拨回 11-02 中午：那一天窗口还没闭合 → 完整性判定必须是「缺」
    // （不拨的话文件是刚刚建的，mtime 在窗口之后，会被判成「完整」）
    const backdated = new Date(2026, 10, 2, 12, 0, 0).getTime() / 1000
    utimesSync(join(diaryPublicDir(), '2026-11-02.md'), backdated, backdated)
    utimesSync(join(diaryPrivateDir(), '2026-11-02.md'), backdated, backdated)

    const result = writeDailyHealth({
      cwd: 'D:\\work',
      config: { diarySessionId: 'session-123' },
      cards: fakeCards(),
      now: DAY4
    })
    assert.equal(result.written, true)
    const line = healthLines()[0]
    assert.match(line, /记忆 项目=1 全局=4（pinned 1 \/ 保护 1 \/ 模糊 2 \/ 遗忘 2）/)
    assert.match(line, /归档 3 条/)
    assert.match(line, /笔记 2 篇/)
    assert.match(line, /日记 最近=2026-11-02 公开\/私密=缺/)
  })

  test('未绑定日记会话时写「未绑」，且不影响整行', () => {
    setupHome()
    writeDailyHealth({ cwd: '', config: { diarySessionId: '' }, cards: fakeCards(), now: DAY4 })
    assert.match(healthLines()[0], /日记 最近=- 公开\/私密=未绑/)
  })

  test('renderHealthLine 本身不碰盘，也不会抛', () => {
    setupHome()
    assert.doesNotThrow(() => renderHealthLine({ cwd: '', config: {}, cards: {}, now: DAY4 }))
    const line = renderHealthLine({ cwd: '', config: {}, cards: {}, now: DAY4 })
    assert.match(line, /^\[health\] 记忆 -/)
  })
})
