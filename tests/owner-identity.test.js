/**
 * 主人身份可配置化（2026-11-04）：node tests/owner-identity.test.js
 *
 * ── 为什么需要这个文件 ──
 * 0.5.2 及以前，主人身份是写死在提示词里的：
 *   · mood.js: `你是「小糖」，是树树的伴侣。`
 *   · mood.js: `⚠️ 树树是男生。写出「她」即算判错。`
 *   · refine.js / 日记流水：`树树` 当人称标签
 * 陌生人装上这个 npm 包，agent 开口前就被告知「你是树树的伴侣」「树树是男生」——
 * 那不是配置，是把作者的生活当成了产品设定。
 *
 * 现在改成三个配置键（ownerName / ownerGender / relationship），默认全空串，
 * 空值时**整句省略**，绝不留下「你是 的伴侣」这种空壳。
 *
 * 这个文件守三件事：
 *   ① 没设时提示词里没有「伴侣」「男生」这类句
 *   ② 设了之后正确出现
 *   ③ 旧配置迁移：没有 ownerName 键 → 默认「树树」并写回 persona.json
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-owner-'))
process.env.DSH_HOME = HOME

const mood = await import('../lib/mood.js')
const memory = await import('../lib/memory.js')
const store = await import('../lib/store.js')
const refine = await import('../lib/refine.js')
const { pickConversation } = await import('../lib/diary-pick.js')

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
  ok(actual === expected, `${name}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

const { buildJudgeSystem, normalizeMoodConfig } = mood
const { DEFAULTS, normalizeConfig } = memory
const { DEFAULT_CONFIG } = store

// --------------------------------------------------------------------------
// ① 没设 ownerName：提示词里不许出现身份/关系/性别句
// --------------------------------------------------------------------------
console.log('没设 ownerName 时的判断提示词：')
{
  const bare = buildJudgeSystem({ self: '小糖', owner: '', ownerName: '', relationships: '', gender: '' })
  ok(bare.startsWith('你是「小糖」。'), '只留「你是「小糖」。」这一句')
  ok(!bare.includes('伴侣'), '没有「伴侣」这句')
  ok(!bare.includes('男生'), '没有「男生」这句')
  ok(!bare.includes('女生'), '没有「女生」这句')
  ok(!/你是「小糖」，是\s*的/.test(bare), '不留「你是「小糖」，是 的…」空壳')

  // 只设名字、没设关系：仍然不写关系句（关系是独立的可选项）
  const nameOnly = buildJudgeSystem({ self: '小糖', owner: '阿明', relationship: '' })
  ok(!nameOnly.includes('伴侣'), '有名字但没设关系时，不写「伴侣」')
  ok(!nameOnly.includes('是阿明的'), '有名字但没设关系时，不留「是阿明的…」空壳')
  ok(!nameOnly.includes('男生'), '没设性别时不写性别句')

  // 只设关系、没设性别：关系句在，性别句不在
  const withRelation = buildJudgeSystem({ self: '小糖', owner: '阿明', ownerName: '阿明', relationship: '搭档' })
  ok(withRelation.includes('是阿明的搭档'), '设了关系就写进去')
  ok(!withRelation.includes('男生'), '性别没设就不猜')
  ok(!withRelation.includes('判错'), '性别没设时「写错代词」那一行整行不写')
}

// --------------------------------------------------------------------------
// ② 设了之后正确出现
// --------------------------------------------------------------------------
console.log('设了 ownerName / ownerGender / relationship 之后：')
{
  const male = buildJudgeSystem({ self: '小糖', owner: '树树', ownerName: '树树', relationship: '伴侣', gender: 'male' })
  ok(male.includes('你是「小糖」，是树树的伴侣。'), '关系句按配置渲染')
  ok(male.includes('树树是男生'), '性别 male 渲染成「男生」')
  ok(male.includes('写出「她」即算判错'), 'male 时禁的是「她」')

  const female = buildJudgeSystem({ self: '小糖', owner: '阿明', ownerName: '阿明', relationship: '搭档', gender: 'female' })
  ok(female.includes('是阿明的搭档'), '关系跟着名字一起换')
  ok(female.includes('阿明是女生'), '性别 female 渲染成「女生」')
  ok(female.includes('写出「他」即算判错'), 'female 时禁的是「他」')

  const alias = buildJudgeSystem({ self: '小糖', owner: '树树', ownerName: '树树', relationship: '伴侣', aliases: '糖糖' })
  ok(alias.includes('树树平时会这样叫你：糖糖'), '别名行仍然照旧（空值整句省略的老规矩不变）')
}

// --------------------------------------------------------------------------
// 配置收敛：类型、空值、性别枚举
// --------------------------------------------------------------------------
console.log('配置默认值与归一：')
{
  eq(DEFAULTS.ownerName, '', 'memory.DEFAULTS.ownerName 默认空串（不是树树）')
  eq(DEFAULTS.ownerGender, '', 'ownerGender 默认空串')
  eq(DEFAULTS.relationship, '', 'relationship 默认空串')
  eq(DEFAULT_CONFIG.ownerName, DEFAULTS.ownerName, 'store.DEFAULT_CONFIG 引用 memory.DEFAULTS（只留一处定义）')
  eq(DEFAULT_CONFIG.ownerGender, DEFAULTS.ownerGender, 'ownerGender 也只有一处定义')
  eq(DEFAULT_CONFIG.relationship, DEFAULTS.relationship, 'relationship 也只有一处定义')

  eq(normalizeConfig({}).ownerName, '', '缺省仍是空串')
  eq(normalizeConfig({ ownerName: '  树树 ' }).ownerName, '树树', '名字去首尾空白')
  eq(normalizeConfig({ ownerName: 123 }).ownerName, '', '非字符串回默认空串')
  eq(normalizeConfig({ ownerGender: 'male' }).ownerGender, 'male', 'male 可用')
  eq(normalizeConfig({ ownerGender: 'female' }).ownerGender, 'female', 'female 可用')
  eq(normalizeConfig({ ownerGender: '男' }).ownerGender, '', '近义词不接受（宁可当没设，也不漏进提示词）')
  eq(normalizeConfig({ relationship: ' 搭档 ' }).relationship, '搭档', '关系去首尾空白')

  // 心情配置读的是 ownerName，但仍认旧键（外部代码还在传 moodOwnerName）
  eq(normalizeMoodConfig({ ownerName: '树树' }).ownerName, '树树', 'normalizeMoodConfig 读新键')
  eq(normalizeMoodConfig({ moodOwnerName: '树树' }).ownerName, '树树', '旧键仍能读出来（兼容）')
  eq(normalizeMoodConfig({ ownerName: '阿明', moodOwnerName: '树树' }).ownerName, '阿明', '两个都有时新键优先')
  eq(normalizeMoodConfig({ ownerGender: 'x' }).ownerGender, '', '心情配置里性别同样收敛')
}

// --------------------------------------------------------------------------
// ③ 迁移：旧配置没有 ownerName → 默认「树树」并写回
// --------------------------------------------------------------------------
console.log('旧配置迁移：')
{
  mkdirSync(join(HOME, 'agents'), { recursive: true })
  const file = store.CONFIG_FILE()

  // 3a. 全新安装：没有配置文件 → 不迁移，默认空串（不能凭空空想出「树树」）
  store.resetCaches()
  eq(store.loadConfig().ownerName, '', '没有配置文件时不迁移（全新安装 = 空串）')
  ok(!existsSync(file), '不迁移就不会凭空写出配置文件')

  // 3b. 有旧键：搬它的值（用户可能自己改过），并写回文件
  writeFileSync(file, JSON.stringify({ moodEnabled: true, moodSelfName: '小糖', moodOwnerName: '树树' }, null, 2), 'utf8')
  store.resetCaches()
  eq(store.loadConfig().ownerName, '树树', '旧配置里没有 ownerName → 迁移成「树树」')
  const written = JSON.parse(readFileSync(file, 'utf8'))
  eq(written.ownerName, '树树', '迁移结果写回了 persona.json')
  eq(written.moodOwnerName, '树树', '旧键保留（不回删用户配置）')
  eq(written.moodSelfName, '小糖', '其他键一个不动')

  // 3c. 迁移只做一次：之后即使改了旧键，也以新键为准
  writeFileSync(file, JSON.stringify({ ownerName: '阿明', moodOwnerName: '树树' }, null, 2), 'utf8')
  store.resetCaches()
  eq(store.loadConfig().ownerName, '阿明', '已经有 ownerName 就不再迁移')

  // 3d. 用户显式设成空串 = 「我就是不设」→ 不能被迁移覆盖成「树树」
  writeFileSync(file, JSON.stringify({ ownerName: '', moodOwnerName: '树树' }, null, 2), 'utf8')
  store.resetCaches()
  eq(store.loadConfig().ownerName, '', '显式空串不被迁移覆盖')

  // 3e. 旧配置里连旧键都没有 → 仍然给旧版默认值「树树」（升级用户不该突然失忆）
  writeFileSync(file, JSON.stringify({ moodEnabled: true }, null, 2), 'utf8')
  store.resetCaches()
  eq(store.loadConfig().ownerName, '树树', '旧配置缺旧键时回落旧版默认值')
  eq(JSON.parse(readFileSync(file, 'utf8')).ownerName, '树树', '同样写回文件')

  // 3f. JSON 坏了不猜、也不写回（写回会把整份配置抹掉）
  writeFileSync(file, '{ 这不是 JSON', 'utf8')
  store.resetCaches()
  eq(store.loadConfig().ownerName, '', '坏配置不迁移')
  eq(readFileSync(file, 'utf8'), '{ 这不是 JSON', '坏配置原样保留，不被覆盖')
}

// --------------------------------------------------------------------------
// 其他进提示词的「树树」：提炼与日记流水
// --------------------------------------------------------------------------
console.log('提炼与日记流水里的人称：')
{
  const bare = refine.buildRefineSystem({})
  ok(!bare.includes('树树'), '提炼提示词不再写死「树树」')
  ok(!bare.includes('主人'), '提炼提示词不再把关系写成「主人」')
  ok(bare.includes('对方'), '没设名字时用中性的「对方」')
  ok(refine.buildRefineSystem({ owner: '阿明' }).includes('阿明'), '设了名字就用名字')

  const rows = [
    { t: Date.now() - 1000, role: 'user', text: '在吗' },
    { t: Date.now(), role: 'assistant', text: '在的' }
  ]
  const barePick = pickConversation(rows, { maxChars: 1000 })
  ok(barePick.text.includes('对方：在吗'), '日记流水没设名字时标「对方」')
  ok(!barePick.text.includes('树树'), '日记流水不再写死「树树」')
  const namedPick = pickConversation(rows, { maxChars: 1000, ownerName: '树树' })
  ok(namedPick.text.includes('树树：在吗'), '设了名字时流水按名字标')
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
