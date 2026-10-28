/**
 * 登记表与工作区清单测试：node tests/registry.test.js
 *
 * ⚠️ 全程把 DSH_HOME 指到临时目录 —— 真实的 agents/projects.json 是
 * dsh-agent-md 共用的登记表，测试绝不能碰。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

// 先换 DSH_HOME 再 import（paths.js 每次调用都读环境变量，这里确保无污染）
const fakeHome = mkdtempSync(join(tmpdir(), 'soul-registry-'))
process.env.DSH_HOME = fakeHome

const registry = await import('../lib/registry.js')
const paths = await import('../lib/paths.js')

console.log('登记（registerProject）：')
{
  const r1 = registry.registerProject('D:\\DSH workspace\\work', { active: true })
  ok(r1.projects.length === 1, '登记一条后表里有一条')
  const entry = r1.projects[0]
  ok(entry.key === 'd:/dsh workspace/work', `key 归一（${entry.key}）`)
  ok(entry.slug === 'work-ea826e02', `slug 与 dsh-agent-md 一致（${entry.slug}）`)
  ok(entry.path.endsWith('work-ea826e02.md'), 'path 指向人格文件')
  ok(entry.active === true, 'active 记下了')

  // 幂等：同一个目录再登记不产生第二条
  registry.registerProject('D:/DSH workspace/work/', { active: true })
  const again = registry.readRegistry()
  ok(again.projects.length === 1, '换个写法再登记仍是 1 条（幂等）')

  registry.registerProject('D:\\DSH workspace\\QQ对话', {})
  ok(registry.readRegistry().projects.length === 2, '不同目录各占一条')
}

console.log('容错：')
{
  writeFileSync(join(fakeHome, 'agents', 'projects.json'), '{ 坏文件', 'utf8')
  const r = registry.readRegistry()
  ok(Array.isArray(r.projects) && r.projects.length === 0, '坏 JSON 回退空表（不炸）')
}

console.log('会话目录名解码（decodeSessionDirName）：')
{
  ok(registry.decodeSessionDirName('--D-team--') === 'D:\\team', 'D:\\team')
  ok(registry.decodeSessionDirName('--D-~80A5~9C7C--') === 'D:\\肥鱼', '中文目录（~XXXX 编码）')
  ok(registry.decodeSessionDirName('junk') === '', '非 --xx-- 格式返回空串')
}

console.log('工作区清单（listWorkspaces）：')
{
  // 登记表来源
  registry.registerProject('D:\\DSH workspace\\work', { active: true })
  // 会话目录来源：手工造一个 --D-team-- 目录
  mkdirSync(join(fakeHome, 'sessions', '--D-team--'), { recursive: true })
  // workspace.json 来源
  mkdirSync(join(fakeHome, 'storages'), { recursive: true })
  writeFileSync(join(fakeHome, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { a: { path: 'D:\\DSH workspace\\work', title: 'work区', updatedAt: '2026-10-28T00:00:00Z', sessionIds: ['s1'] } } },
  }), 'utf8')

  const list = registry.listWorkspaces()
  const work = list.find((w) => w.key === 'd:/dsh workspace/work')
  ok(work !== undefined, '三个来源合并后能看见 work')
  ok(work.sources.includes('workspace') && work.sources.includes('persona'), `来源标注齐（${work.sources.join('/')}）`)
  ok(work.exists === false, '人格文件不存在时 exists=false')
  ok(work.displayName === 'work区', 'workspace.json 的 title 优先做显示名')

  const team = list.find((w) => w.key === 'd:/team')
  ok(team !== undefined && team.sources.includes('sessions'), '会话目录解码出来的工作区也在清单里')
}

console.log('清理：')
{
  try { rmSync(fakeHome, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  ok(true, '临时目录已清理')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
