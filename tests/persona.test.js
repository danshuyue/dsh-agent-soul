/**
 * 人格层测试：node tests/persona.test.js
 *
 * 重点验证「叠加」这件事真的成立 —— 这是它相对 dsh-agent-md 的差异点，
 * 也是 DSH 问题库 Q20 记录的那个坑（全局约定被项目人格整份吃掉）。
 *
 * 会造一个临时 DSH_HOME（不碰真实的 ~/.dsh）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

// 必须在 import 之前把 DSH_HOME 指到临时目录：paths.js 在调用时读它，但提前设更保险
const sandbox = mkdtempSync(join(tmpdir(), 'soul-persona-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents', 'projects'), { recursive: true })

const {
  cleanPersona,
  composePersona,
  defuseTemplate,
  mergeSections,
  resolveSources,
  splitSections,
  stripComments,
  MAX_INJECT_CHARS
} = await import('../lib/persona.js')
const { shortHash, slugFor } = await import('../lib/paths.js')

const GLOBAL = `# 你是谁
你是一个工程搭子。

# 语气与形态
说话干脆，不客套。

# 工程约定
注释用中文。
`

const PROJECT = `# 工程约定
这个项目是 Vue 3 + Vite，不要引入 React。

# 这个项目里你是
一个只写必要注释的前端维护者。
`

console.log('小节切分：')
{
  const sections = splitSections(GLOBAL)
  eq(sections.length, 3, '切成 3 个小节')
  eq(sections[0].heading, '# 你是谁', '第一个标题对')
  ok(sections[0].body.includes('工程搭子'), '正文跟着标题走')

  const withPreamble = splitSections('前面的话\n\n# 标题\n内容')
  eq(withPreamble[0].heading, '', '标题之前的内容单独成段')
  eq(withPreamble.length, 2, '前言 + 1 个小节')

  eq(splitSections('').length, 0, '空文本返回空')
  const h2 = splitSections('# 一级\n内容\n## 二级\n子内容')
  eq(h2.length, 1, '二级标题不拆出去（跟着一级走）')
  ok(h2[0].body.includes('## 二级'), '二级标题保留在正文里')
}

console.log('小节合并（这是相对 dsh-agent-md 的关键差异）：')
{
  const merged = mergeSections(GLOBAL, PROJECT)
  const headings = splitSections(merged).map((section) => section.heading)
  eq(headings, ['# 工程约定', '# 这个项目里你是', '# 你是谁', '# 语气与形态'], '项目小节在前，全局独有小节补齐在后')
  ok(merged.includes('Vue 3 + Vite'), '项目内容在')
  ok(!merged.includes('注释用中文'), '同名小节被项目覆盖，全局那份不重复出现')
  ok(merged.includes('说话干脆'), '全局独有的小节没丢')

  eq(mergeSections('', PROJECT), PROJECT.trim(), '只有项目：直接返回项目')
  eq(mergeSections(GLOBAL, ''), GLOBAL.trim(), '只有全局：直接返回全局')
}

console.log('目录标识（必须与 dsh-agent-md 完全一致）：')
{
  // 基准值取自他机器上真实的 agents/projects.json —— 对不上就读不到已有的人格文件，
  // 而且不报错，只表现成「项目人格：没有」。这是 2026-10-28 实际发生过的事故。
  const cases = [
    ['d:/dsh workspace/work', 'ea826e02'],
    ['d:/dsh workspace/qq对话', '8403a927'],
    ['d:/dsh workspace/1', '7f0555b2'],
    ['c:/users/administrator/documents/deepseek/harness/default/workspace', '64e5dda4'],
    ['c:/users/administrator/documents/deepseek-harness/default-workspace', '64c39a80'],
  ]
  for (const [key, want] of cases) {
    eq(shortHash(key), want, `FNV-1a 命中 ${key.length > 40 ? `${key.slice(0, 40)}…` : key}`)
  }
  // 同一个目录的不同写法必须算出同一个标识，否则一换写法就"丢人格"
  // 用 String.raw：反斜杠路径在这个文件里被转义吃掉过两次，别再踩
  const a = slugFor(String.raw`D:\DSH workspace\work`)
  const b = slugFor('d:/dsh workspace/work/')
  const c = slugFor('D:/DSH WORKSPACE/WORK')
  eq(a.slug, b.slug, '反斜杠 / 正斜杠写法算出同一个 slug')
  eq(a.slug, c.slug, '大小写不同算出同一个 slug')
  eq(a.slug, 'work-ea826e02', '真实路径的 slug 对得上')
  eq(slugFor('').slug, 'global', '空 cwd 用 global')
}

console.log('清洗：')
{
  eq(defuseTemplate('我是 {{名字}} 的搭子'), '我是 {名字} 的搭子', '{{xxx}} 降级成 {xxx}（避免整轮注入失败）')
  eq(stripComments('正文<!-- 这是备注 -->继续'), '正文继续', 'HTML 注释被去掉')
  ok(!cleanPersona('# 标题\n<!-- 例：这样写 -->\n正文').includes('例：'), '清洗后不带示例注释')
  eq(cleanPersona('a\r\n\r\n\r\n\r\nb'), 'a\n\nb', '压掉多余空行')
}

console.log('合成（没有项目文件时）：')
{
  writeFileSync(join(sandbox, 'AGENT.md'), GLOBAL, 'utf8')
  const r = composePersona({ cwd: '', config: {} })
  ok(r.text.includes('工程搭子'), '注入了全局人格')
  eq(r.sources.length, 1, '来源只有全局一份')
  eq(r.mode, 'stack', '默认是叠加模式')
}

console.log('合成（项目人格在 cwd 里）：')
{
  const projectDir = join(sandbox, 'proj-a')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'AGENT.md'), PROJECT, 'utf8')

  const stack = composePersona({ cwd: projectDir, config: { mode: 'stack' } })
  ok(stack.text.includes('Vue 3 + Vite'), '项目内容在')
  ok(stack.text.includes('# 语气与形态'), '全局底座也叠上了（stack 模式）')
  eq(stack.sources.length, 2, '来源两份都记了')

  const exclusive = composePersona({ cwd: projectDir, config: { mode: 'exclusive' } })
  ok(exclusive.text.includes('Vue 3 + Vite'), '项目内容在')
  ok(!exclusive.text.includes('# 语气与形态'), 'exclusive 模式下全局整份不注入（跟 agent-md 一致）')
  eq(exclusive.sources.length, 1, '只记了项目那份')

  const noGlobal = composePersona({ cwd: projectDir, config: { includeGlobal: false } })
  ok(!noGlobal.text.includes('工程搭子'), 'includeGlobal=false 时不注入全局')
}

console.log('项目人格在本机存储：')
{
  const projectDir = join(sandbox, 'proj-b')
  mkdirSync(projectDir, { recursive: true })
  // 不建 cwd/AGENT.md，走 projects/<slug>.md 那条路
  const { slugFor } = await import('../lib/paths.js')
  const slug = slugFor(projectDir)
  writeFileSync(slug.personaPath, '# 只存在于本机\n这是本机存储的项目人格。', 'utf8')

  const r = composePersona({ cwd: projectDir, config: {} })
  ok(r.text.includes('本机存储的项目人格'), '认出了本机存储的项目人格')
  eq(resolveSources({ cwd: projectDir, config: {} }).project?.kind, 'stored', '来源类型标记为 stored')
}

console.log('截断：')
{
  const long = `# 超长\n${'字'.repeat(MAX_INJECT_CHARS + 500)}`
  const file = join(sandbox, 'AGENT.md')
  writeFileSync(file, long, 'utf8')
  const r = composePersona({ cwd: '', config: {} })
  eq(r.truncated, true, '超长被标记截断')
  ok(r.text.includes('被截断了'), '提示里说明了截断')
  ok(r.text.length <= MAX_INJECT_CHARS + 120, `长度控制在 ${r.text.length}`)
}

console.log('开关：')
{
  writeFileSync(join(sandbox, 'AGENT.md'), GLOBAL, 'utf8')
  const off = composePersona({ cwd: '', config: { projectPersonaEnabled: false } })
  ok(off.text.includes('工程搭子'), '关掉项目人格后仍然注入全局')
  const none = composePersona({ cwd: '', config: { includeGlobal: false } })
  eq(none.text, '', '两边都关掉时注入空串')
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
