/**
 * 写入口的归属判断（2026-11-05）。
 *
 * 背景：自动提取原来是「先全写项目卡，再把 fact / 高分条目抄进全局卡」。
 * 结果项目卡慢慢变成全局卡的副本（合并前 63 条里 50 条是副本），同一句在注入里出现两遍。
 *
 * 现在的规则：写之前先判 —— 只在这个工作区成立的进项目卡，其余进全局卡，不再双写。
 * 判断宁可保守（默认 global）：判错成 global 只是多一条噪音，
 * 判错成 project 就是换个对话彻底失忆。
 *
 * 注意：store 的卡片缓存按文件路径存，测试之间不重读磁盘。
 * 所以每个用例用**各自独立的 cwd**，不要指望删临时目录来清缓存。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-scope-'))
process.env.DSH_HOME = HOME

const { classifyScope } = await import('../lib/memory.js')
const store = await import('../lib/store.js')
const { ensureDirs } = await import('../lib/paths.js')

const cwdOf = (name) => join(HOME, 'workspace', name)

describe('classifyScope（写之前判归属）', () => {
  const CWD = cwdOf('scope-cases')

  test('项目独有：指代词 + 载体名词', () => {
    assert.equal(classifyScope('这个项目的缓存按文件修改时间失效', CWD), 'project')
    assert.equal(classifyScope('本文件里那三个函数要一起改', CWD), 'project')
    assert.equal(classifyScope('当前分支还没合', CWD), 'project')
  })

  test('项目独有：具体技术标识', () => {
    assert.equal(classifyScope('savePurposeState() 写失败就会回退', CWD), 'project')
    assert.equal(classifyScope('lib/store.js:223 的缓存逻辑', CWD), 'project')
    assert.equal(classifyScope('C:\\work\\proj\\a.cs 里改的', CWD), 'project')
  })

  test('项目独有：正文里直接点了工作区名字', () => {
    assert.equal(classifyScope('QQ对话 这个目录下的约定', CWD), 'project')
  })

  test('通用事实一律 global（哪怕带「项目」「插件」这种词）', () => {
    assert.equal(classifyScope('树树自己开发了两个插件', CWD), 'global')
    assert.equal(classifyScope('树树有个私人的 AI 伴侣项目', CWD), 'global')
    assert.equal(classifyScope('树树是烟台大学机器人工程专业大二学生', CWD), 'global')
    assert.equal(classifyScope('树树不敢吃辣', CWD), 'global')
    assert.equal(classifyScope('树树对课上的内容兴趣不大，比如复变函数与积分变换', CWD), 'global')
  })

  test('没有工作区 / 项目记忆关掉 → 只能 global', () => {
    assert.equal(classifyScope('这个项目的缓存按文件修改时间失效', ''), 'global')
    assert.equal(classifyScope('这个项目的缓存按文件修改时间失效', CWD, { projectMemoryEnabled: false }), 'global')
  })

  test('空文本 → global', () => {
    assert.equal(classifyScope('   ', CWD), 'global')
  })
})

describe('写入口按判断落卡（不再双写）', () => {
  test('writeMemory scope=auto：项目类进项目卡，事实类进全局卡', () => {
    ensureDirs()
    const cwd = cwdOf('auto-route')
    const a = store.writeMemory({ cwd, scope: 'auto', input: { text: '这个项目的缓存按文件修改时间失效（auto A）' } })
    const b = store.writeMemory({ cwd, scope: 'auto', input: { text: '树树是烟台大学机器人工程专业大二学生（auto B）' } })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)

    const project = store.projectCard(cwd)
    const global = store.globalCard()
    assert.equal(project.records.length, 1, '项目卡只放项目类那条')
    assert.match(project.records[0].text, /auto A/)
    assert.equal(global.records.some((r) => r.text.includes('auto A')), false, '项目类没有双写进全局')
    assert.equal(global.records.some((r) => r.text.includes('auto B')), true)
  })

  test('writeMemory 显式 global 覆盖判断', () => {
    ensureDirs()
    const cwd = cwdOf('explicit-global')
    const r = store.writeMemory({ cwd, scope: 'global', input: { text: '这个项目的版本号是 0.8.0（显式 global）' } })
    assert.equal(r.ok, true)
    assert.equal(store.projectCard(cwd).records.length, 0)
    assert.equal(store.globalCard().records.some((x) => x.text.includes('显式 global')), true)
  })

  test('writeAutoMemories：一次批次分别落两张卡，各自只出现一次', () => {
    ensureDirs()
    const cwd = cwdOf('batch-route')
    const report = store.writeAutoMemories(cwd, [
      { text: '这个项目的测试要先构建客户端（批次 A）', kind: 'fact', importance: 60 },
      { text: '树树喜欢软件方向（批次 B）', kind: 'preference', importance: 60 }
    ])
    assert.equal(report.written, 2)
    assert.equal(report.promoted, 0)

    const project = store.projectCard(cwd).records
    const global = store.globalCard().records
    assert.equal(project.length, 1, '项目卡只留项目独有的那条')
    assert.match(project[0].text, /批次 A/)
    assert.equal(global.some((r) => r.text.includes('批次 A')), false, '没有双写进全局卡')
    assert.equal(global.some((r) => r.text.includes('批次 B')), true)
  })
})
