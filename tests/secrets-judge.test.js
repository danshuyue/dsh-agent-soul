/**
 * secrets-judge.test.js —— 密钥存储 + 硅基流动判定通路（2026-11-01）
 *
 * 两件事都容易「看着能用，其实没接上」：
 *   · 密钥存了但读不回来（编码/加密范围写错）
 *   · 配了 provider 但请求根本没发出去（还是走了宿主会话模型）
 * 所以这里既查文件里有没有明文，也查 fetch 到底有没有被打。
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'soul-secrets-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents'), { recursive: true })

const secrets = await import('../lib/secrets.js')
const mood = await import('../lib/mood.js')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

console.log('\n① 存 → 读 → 状态 → 删')
{
  const r = secrets.saveSecret('siliconflow', 'sk-unit-test-0001')
  eq(r.ok, true, '保存成功')
  eq(secrets.loadSecret('siliconflow'), 'sk-unit-test-0001', '读回来是原文')

  const info = secrets.secretInfo('siliconflow')
  eq(info.exists, true, '状态：存在')
  eq(info.encrypted, true, '状态：加密')
  eq('' in info, false, '状态里没有明文')

  // 文件里绝不许出现明文
  const raw = readFileSync(secrets.secretPath('siliconflow'), 'utf8')
  eq(raw.includes('sk-unit-test-0001'), false, '文件里没有明文密钥')
  eq(raw.startsWith('dpapi:'), true, '文件是 DPAPI 密文')

  // 缓存清掉后仍能解（验证是真的存在盘上，不是只活在内存）
  secrets.__resetSecretsForTest()
  eq(secrets.loadSecret('siliconflow'), 'sk-unit-test-0001', '清缓存后仍能解密')

  eq(secrets.deleteSecret('siliconflow'), true, '删除成功')
  eq(secrets.secretInfo('siliconflow').exists, false, '删后状态为不存在')
}

console.log('\n② 名字校验与环境变量覆盖')
{
  eq(secrets.saveSecret('../evil', 'x').ok, false, '路径穿越名字被拒')
  eq(secrets.saveSecret('ok-name.1', 'v').ok, true, '合法名字可以存')

  process.env.SOUL_SECRET_SILICONFLOW = 'sk-from-env'
  secrets.__resetSecretsForTest()
  eq(secrets.loadSecret('siliconflow'), 'sk-from-env', '环境变量优先')
  delete process.env.SOUL_SECRET_SILICONFLOW
  secrets.__resetSecretsForTest()
}

console.log('\n③ 配了 siliconflow 就必须走 HTTP，而不是宿主模型')
{
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) })
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"moodDelta":-2,"dims":{"sad":2},"reason":"他难受，我心里也跟着沉了一下","confidence":85}' } }] })
    }
  }
  secrets.saveSecret('siliconflow', 'sk-http-test')
  const delta = await mood.judgeMood(null, null, '今天好累', '那先歇会儿', '', {
    self: '糖糖', owner: '树树', judgeProvider: 'siliconflow', judgeModel: 'Qwen/Qwen2.5-7B-Instruct'
  }, () => {})
  eq(calls.length, 1, '发了 1 次请求')
  eq(calls[0].url.includes('siliconflow.cn'), true, '打到硅基流动的地址')
  eq(calls[0].body.model, 'Qwen/Qwen2.5-7B-Instruct', '用的是配的模型')
  eq(delta.moodDelta, -2, '解析出 moodDelta')
  eq(delta.confidence, 85, '解析出 confidence')

  // 失败一律 null，绝不抛
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' })
  const bad = await mood.judgeMood(null, null, 'a', 'b', '', {
    self: '糖糖', owner: '树树', judgeProvider: 'siliconflow', judgeModel: 'm'
  }, () => {})
  eq(bad, null, 'HTTP 失败返回 null（不炸判断链）')

  globalThis.fetch = realFetch
  secrets.deleteSecret('siliconflow')
  secrets.__resetSecretsForTest()
}

console.log('\n④ 没有密钥时不许假装成功')
{
  let called = false
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) } }
  const r = await mood.judgeMood(null, null, 'a', 'b', '', {
    self: '糖糖', owner: '树树', judgeProvider: 'siliconflow', judgeModel: 'm'
  }, () => {})
  eq(r, null, '没有密钥也没有宿主 llm → null')
  eq(called, false, '没有密钥时根本没发请求')
  globalThis.fetch = realFetch
}

console.log('\n⑤ 判断提示词：压缩后仍保留关键判据')
{
  const sys = mood.buildJudgeSystem({ self: '糖糖', owner: '树树', aliases: '糖糖、小糖' })
  // 2026-11-03：提示词又加了两条真规则（禁套话 / 别为顺利白涨），
  // 字数从 1800 涨到 1967。上限跟着放宽到 2400，但**不能无限放** ——
  // 这段每轮都会塞进判断请求里，膨胀就是按轮收费。
  ok(sys.length < 2400, `提示词控制在 2400 字内（实际 ${sys.length}）`)
  ok(sys.includes('别因为「答应了」就判成好事'), '保留「答应了也算没吃」那条守卫')
  ok(sys.includes('moodDelta **负**') && sys.includes('moodDelta **正**'), '正负号写死在幅度表里')
  ok(sys.includes('代词一律不用'), '保留代词规则')
  ok(sys.includes('两段式、全过去式'), '保留 reason 时态规则')
  ok(sys.includes('confidence'), '保留 confidence 说明')
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
