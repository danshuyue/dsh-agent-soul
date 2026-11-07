/**
 * 笔记测试：node tests/notes.test.js，退出码 0 = 全过。
 *
 * 这个模块是全插件**唯一允许模型指定文件名**的入口，所以测试重心不在「写进去读得出来」
 * （那个一次就能试出来），而在**安全边界和静默失效**：
 *   · 路径穿越 / Windows 保留名 / 非法字符 —— 任何一条漏了就是任意文件写入；
 *   · 索引与目录不一致（手动改文件、手动删文件、索引被写坏）—— 漏了就是「写了却查不到」；
 *   · 上限与重名 —— 漏了就是她的手滑变成静默覆盖。
 *
 * 全部跑在临时 DSH_HOME 下，不碰 ~/.dsh。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'soul-notes-test-'))

const {
  MAX_NOTES,
  MAX_NOTE_CHARS,
  appendNote,
  cleanTitle,
  deleteNote,
  listNotes,
  loadIndex,
  readNote,
  reconcile,
  renameNote,
  renderNotesBlock,
  saveIndex,
  summaryOf,
  writeNote,
  __resetNotesCacheForTest
} = await import('../lib/notes.js')
const { notePath, notesDir, notesIndexPath, notesTrashDir } = await import('../lib/paths.js')

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

const tmpRoot = process.env.DSH_HOME
const reset = () => {
  rmSync(join(tmpRoot, 'agents'), { recursive: true, force: true })
  mkdirSync(notesDir(), { recursive: true })
}

// --------------------------------------------------------------------------

console.log('标题清洗：这是唯一允许模型指定文件名的入口（2026-11-04）：')
{
  for (const bad of ['../../AGENT.md', '..\\..\\x', 'a/b', 'ev..il', '..', '.hidden/../x']) {
    eq(cleanTitle(bad).ok, false, `拒绝「${bad}」`)
  }
  eq(cleanTitle('').ok, false, '空标题拒绝')
  eq(cleanTitle('   ').ok, false, '纯空白标题拒绝')
  eq(cleanTitle('CON').ok, false, 'Windows 保留名 CON 拒绝')
  eq(cleanTitle('com3').ok, false, 'Windows 保留名 com3 拒绝（不分大小写）')
  eq(cleanTitle('a:b*c?').ok, false, 'Windows 非法字符拒绝')

  eq(cleanTitle('关于树树的观察').slug, '关于树树的观察', '中文标题原样保留')
  eq(cleanTitle('  STM32 学习笔记  ').slug, 'STM32 学习笔记', '前后空白被去掉')
  eq(cleanTitle('树树的作息（一）').slug, '树树的作息（一）', '全角括号允许')
  ok(cleanTitle('x'.repeat(80)).slug.length <= 40, '超长标题被截到 40 字以内')
}

console.log('\n新建 / 读取 / 列表：')
{
  reset()
  const a = writeNote({ title: '关于树树的观察', content: '# 深夜改代码\n\n他总在两点后才睡。' })
  eq(a.ok, true, '新建第一篇成功')
  eq(a.created, true, '标记为新建')
  ok(readFileSync(notePath('关于树树的观察'), 'utf8').includes('两点后'), '文件真的落在 notes/ 下且内容正确')

  const b = writeNote({ title: '我想问的事', content: '为什么不肯早点睡？' })
  eq(b.ok, true, '新建第二篇成功')
  eq(listNotes().length, 2, '列表返回 2 篇')

  const got = readNote('我想问的事')
  eq(got.ok, true, '读得到')
  eq(got.text.includes('早点睡'), true, '正文内容正确')
  eq(got.note.chars > 0, true, '带上字数')

  eq(readNote('不存在的一篇').ok, false, '读不存在的篇返回失败而不是抛异常')
  eq(readNote('../../x').ok, false, '读的时候也拦路径穿越')
}

console.log('\n重名与覆盖（静默覆盖是最坏的失败）：')
{
  reset()
  writeNote({ title: '随笔', content: '第一版' })
  const again = writeNote({ title: '随笔', content: '第二版' })
  eq(again.ok, false, '同名不带 overwrite 被拒绝')
  eq(readNote('随笔').text.includes('第一版'), true, '拒绝时原内容没被清掉')
  eq(writeNote({ title: '随笔', content: '第二版', overwrite: true }).ok, true, '带 overwrite 才允许整篇替换')
  eq(readNote('随笔').text.includes('第二版'), true, '覆盖后是新内容')
}

console.log('\n续写：')
{
  reset()
  const first = appendNote({ title: '还没建过的篇', content: '第一段' })
  eq(first.ok, true, '追加不存在的篇会自动新建')
  appendNote({ title: '还没建过的篇', content: '第二段' })
  const text = readNote('还没建过的篇').text
  ok(text.includes('第一段') && text.includes('第二段'), '两段都在')
  ok(text.indexOf('第一段') < text.indexOf('第二段'), '顺序正确（旧的在前）')
  eq(appendNote({ title: '还没建过的篇', content: '   ' }).ok, false, '追加空内容被拒绝')
}

console.log('\n改标题：')
{
  reset()
  writeNote({ title: '旧名字', content: '正文' })
  const r = renameNote('旧名字', '新名字')
  eq(r.ok, true, '改名成功')
  eq(r.renamed, true, '标记为真的改了')
  eq(readNote('新名字').ok, true, '新名字读得到')
  eq(readNote('旧名字').ok, false, '旧名字读不到（不是索引里改个字，是真 rename）')
  eq(listNotes()[0].title, '新名字', '索引里的标题也跟着变了')

  writeNote({ title: '另一篇', content: 'x' })
  eq(renameNote('新名字', '另一篇').ok, false, '改成已存在的标题会被拒绝')
  eq(renameNote('不存在', '随便').ok, false, '改不存在的篇返回失败')
}

console.log('\n删除（不真删，进回收站）：')
{
  reset()
  writeNote({ title: '要删的', content: '这段内容' })
  const d = deleteNote('要删的')
  eq(d.ok, true, '删除成功')
  eq(readNote('要删的').ok, false, '删完读不到')
  eq(listNotes().length, 0, '列表里没有了')
  const trash = readdirSync(notesTrashDir()).filter((f) => f.endsWith('.md'))
  eq(trash.length, 1, '回收站里有一个文件')
  eq(readFileSync(join(notesTrashDir(), trash[0]), 'utf8').includes('这段内容'), true, '回收站里内容完整，找得回来')
  eq(deleteNote('要删的').ok, false, '再删一次返回失败而不是报错')
}

console.log('\n上限：')
{
  reset()
  const tooLong = 'x'.repeat(MAX_NOTE_CHARS + 1)
  eq(writeNote({ title: '超长', content: tooLong }).ok, false, `超过 ${MAX_NOTE_CHARS} 字被拒绝`)
  eq(writeNote({ title: '空', content: '   ' }).ok, false, '空正文被拒绝')

  reset()
  for (let i = 0; i < MAX_NOTES; i += 1) writeNote({ title: `第 ${i} 篇`, content: `内容 ${i}` })
  eq(listNotes().length, MAX_NOTES, `写满 ${MAX_NOTES} 篇`)
  const over = writeNote({ title: '再来一篇', content: 'x' })
  eq(over.ok, false, '超篇数上限被拒绝')
  ok(String(over.reason).includes('上限'), '拒绝理由说明了是上限问题')
  // 覆盖已有的篇不该被上限挡住 —— 否则到顶之后连改都改不了
  eq(writeNote({ title: '第 0 篇', content: '改过', overwrite: true }).ok, true, '到顶后仍能覆盖已有篇')
}

console.log('\n索引与目录不一致（索引只是缓存，md 才是真相）：')
{
  reset()
  writeNote({ title: '索引里有的', content: '正文' })
  // 直接把文件系统改掉之后必须清缓存 —— reconcile 有 3 秒缓存（注入路径每轮都调它），
  // 测试不该靠「等 3 秒」来过，那样既慢又不稳定。
  __resetNotesCacheForTest()
  // ① 手动放一个 md 进来（模拟用户用编辑器新建）
  writeFileSync(notePath('手动放的'), '# 我自己建的\n\n内容', 'utf8')
  const after = listNotes()
  eq(after.length, 2, '目录里多出来的 md 被自动收进索引')
  ok(after.some((n) => n.slug === '手动放的'), '新文件出现在列表里')
  ok(after.find((n) => n.slug === '手动放的').summary.includes('我自己建的'), '摘要从正文算出来了')

  // ② 手动删掉文件
  rmSync(notePath('手动放的'), { force: true })
  __resetNotesCacheForTest()
  eq(listNotes().length, 1, '文件没了，索引条目跟着清掉')

  // ③ 索引被写坏
  writeFileSync(notesIndexPath(), '{ 这不是合法 JSON', 'utf8')
  __resetNotesCacheForTest()
  const rebuilt = listNotes()
  eq(rebuilt.length, 1, '索引坏了能从目录重建，不是整块不可用')
  eq(rebuilt[0].title, '索引里有的', '重建出来的条目正确')

  // ④ 手动改正文，索引要跟着更新
  writeFileSync(notePath('索引里有的'), '# 换了一整段内容\n\n很长很长', 'utf8')
  __resetNotesCacheForTest()
  const changed = listNotes()
  ok(changed[0].summary.includes('换了一整段'), '手动改过的正文，摘要会重新算')
}

console.log('\n读失败不能把这篇从索引里删掉（2026-11-04 修 B11）：')
{
  // 用一个「同名目录」冒充 .md 文件：readdirSync 会把它列出来（名字以 .md 结尾），
  // 而 readText 读目录会抛 EISDIR —— 正好模拟「文件在、但这一瞬间读不出来」。
  reset()
  writeNote({ title: '正常的一篇', content: '正文' })
  mkdirSync(notePath('读不出来的'), { recursive: true })
  __resetNotesCacheForTest()

  const list = listNotes()
  ok(list.some((n) => n.slug === '正常的一篇'), '正常那篇还在')
  ok(list.some((n) => n.slug === '读不出来的'), '读失败那篇没有被从索引里剔除（原来的 continue 会让它消失）')

  rmSync(notePath('读不出来的'), { recursive: true, force: true })
  __resetNotesCacheForTest()
}

console.log('\n读失败的占位要能重试（2026-11-04 修新④）：')
{
  reset()
  writeNote({ title: '正常的一篇', content: 'x' })
  mkdirSync(notePath('坏掉的'), { recursive: true })
  __resetNotesCacheForTest()
  listNotes()

  const idx = JSON.parse(readFileSync(notesIndexPath(), 'utf8'))
  const stub = idx.notes.find((n) => n.slug === '坏掉的')
  ok(stub !== undefined && stub.retry === true, '读失败写下的占位带 retry 标记')
  eq(stub?.chars, 0, '占位字数是 0')

  // 修好文件系统：换成真文件，应该被重新读进来（不能一直卡在 0 字）
  rmSync(notePath('坏掉的'), { recursive: true, force: true })
  writeFileSync(notePath('坏掉的'), '现在能读了', 'utf8')
  __resetNotesCacheForTest()
  const after = listNotes().find((n) => n.slug === '坏掉的')
  ok(after !== undefined && after.chars > 0, '文件修好后重新读进来（不再是 0 字的桩）')
  eq(after?.retry, undefined, '读成功后不再带 retry 标记')
}

console.log('\n注入渲染（Inline & Spill：只给索引，正文留在窗口外）：')
{
  reset()
  __resetNotesCacheForTest()
  eq(renderNotesBlock(), '', '一篇都没有时返回空串（不注入空标题占位置）')

  // 用一段超过摘要长度的正文：摘要该被截到 36 字，完整正文不该出现在块里。
  // （之前用短正文测这条是无效的 —— 摘要本来就是正文第一行，正文短的话两者一样长。）
  const longLine = '这是他深夜改代码的样子，我看了很久也没说话，只是把灯调暗了一点，然后坐在旁边等他自己停下来。'
  writeNote({ title: '第一篇', content: longLine })
  const block = renderNotesBlock({ maxChars: 600 })
  ok(block.includes('第一篇'), '索引里有标题')
  ok(block.includes('字'), '带字数')
  ok(!block.includes(longLine), '完整正文没有被整段注入')
  ok(block.includes('…'), '摘要被截断，用省略号收尾')

  // 预算很小时不能超
  const tiny = renderNotesBlock({ maxChars: 60 })
  ok(tiny.length <= 60 * 3, '预算极小也不会把三十篇全塞进来')

  reset()
  for (let i = 0; i < 8; i += 1) writeNote({ title: `笔记${i}`, content: `第 ${i} 篇的正文` })
  // 2026-11-06 R03/H-3：边界标签变长（带 nonce），120 字预算已经放不下「标题 + 一条」，
  // 所以预算提到 200 才走得到「列不全」这条分支；极小预算的行为单独断言。
  const small = renderNotesBlock({ maxChars: 200 })
  ok(small.includes('soul_note list'), '列不全时提示用 list 看全部')
  eq(renderNotesBlock({ maxChars: 60 }), '', '预算连标题带一条都放不下时返回空串（不注入半截）')
}

console.log('\n摘要：')
{
  eq(summaryOf('# 标题\n\n正文'), '标题', '跳过 md 的 # 标记')
  eq(summaryOf('\n\n\n正文在第三行'), '正文在第三行', '跳过空行')
  eq(summaryOf('**加粗**和`代码`'), '加粗和代码', '去掉 md 装饰符')
  ok(summaryOf('长'.repeat(100)).length <= 37, '过长时截断并加省略号')
}

console.log('\n收尾：')
{
  rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
