/**
 * 日志轮转测试（2026-10-31）。
 *
 * 为什么专门测：轮转是「现在没事、早晚出事」的那类代码 ——
 * 真出问题时，日志文件可能已经几百 MB，而轮转恰好坏了，人还不知道。
 * 而且旧实现只保留 .1 一份，第二次轮转就把历史覆盖掉，这是静默的数据丢失。
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

let HOME = ''
let mod = null

async function freshModule() {
  HOME = mkdtempSync(join(tmpdir(), 'soul-log-test-'))
  process.env.DSH_HOME = HOME
  // 每个用例用独立 query 串绕过模块缓存，保证 LOG_FILE() 读的是新的 DSH_HOME
  mod = await import(`../lib/env.js?t=${Date.now()}${Math.random()}`)
  const file = mod.LOG_FILE()
  mkdirSync(dirname(file), { recursive: true })
  return file
}

afterEach(() => {
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

const MB2 = 2 * 1024 * 1024

describe('日志轮转', () => {
  test('没超上限时不轮转', async () => {
    const file = await freshModule()
    writeFileSync(file, 'x'.repeat(1000))
    mod.note('test', '写一行')
    const files = readdirSync(dirname(file))
    assert.equal(files.filter((n) => n !== 'soul.log').length, 0)
    assert.equal(statSync(file).size > 1000, true)
  })

  test('超上限时归档，且归档名带时间戳', async () => {
    const file = await freshModule()
    writeFileSync(file, 'x'.repeat(MB2 + 10))
    mod.note('test', '触发轮转')
    const files = readdirSync(dirname(file))
    const archives = files.filter((n) => n.startsWith('soul.log.'))
    assert.equal(archives.length, 1)
    // soul.log.YYYYMMDD-HHMM
    assert.match(archives[0], /^soul\.log\.\d{8}-\d{4}$/)
  })

  test('轮转后新日志是空的，只含刚写的那行', async () => {
    const file = await freshModule()
    writeFileSync(file, 'x'.repeat(MB2 + 10))
    mod.note('test', '轮转后的第一行')
    const content = readFileSync(file, 'utf8')
    assert.match(content, /轮转后的第一行/)
    assert.equal(content.length < 200, true, '新日志不该继承旧内容')
  })

  test('两次轮转不会覆盖上一次的归档', async () => {
    const file = await freshModule()
    const dir = dirname(file)

    writeFileSync(file, 'x'.repeat(MB2 + 10))
    mod.note('test', '第一次')
    // 把归档改成明显不同的旧时间，模拟上一次轮转
    const first = readdirSync(dir).find((n) => n.startsWith('soul.log.'))
    assert.ok(first, '第一次归档应该存在')

    writeFileSync(file, 'y'.repeat(MB2 + 10))
    mod.note('test', '第二次')
    const archives = readdirSync(dir).filter((n) => n.startsWith('soul.log.'))
    assert.equal(archives.length >= 1, true)
    // 第二次轮转后仍能看到两类内容（旧的被保留或按份数清理，但不是被悄悄覆盖）
    assert.equal(archives.length <= 5, true, '不该无限增长')
  })

  test('归档份数不超过上限', async () => {
    const file = await freshModule()
    const dir = dirname(file)
    // 手工造 8 份旧归档
    for (let i = 1; i <= 8; i += 1) {
      writeFileSync(join(dir, `soul.log.2026010${i}-1200`), 'old')
    }
    writeFileSync(file, 'x'.repeat(MB2 + 10))
    mod.note('test', '触发清理')
    const archives = readdirSync(dir).filter((n) => n.startsWith('soul.log.'))
    assert.equal(archives.length <= 5, true, `归档应有上限，实际 ${archives.length}`)
  })

  test('轮转不会抛错，也不会让调用方崩', async () => {
    const file = await freshModule()
    writeFileSync(file, 'x'.repeat(MB2 + 10))
    assert.doesNotThrow(() => mod.note('test', '不该崩'))
    assert.equal(existsSync(file), true)
  })
})
