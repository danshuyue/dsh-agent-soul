/**
 * 记忆提炼测试：node tests/refine.test.js
 *
 * 这一层是「记忆」和「对话存档」的分界线 —— 没有它，记忆卡里躺的是
 * 「（QQ 私聊·用户本人 [QQ号]）起了起了」这种原话。
 *
 * 钉三件事：
 *   1. 提示词的硬约束还在（不许编、没信息量就输出空数组）
 *   2. 模型输出乱一点也能解析（markdown 包裹、前后带废话、只给单个对象）
 *   3. 任何失败都返回 null —— 调用方据此退回原话直存，不许丢信息
 */
import { buildRefineSystem, buildRefineUser, parseRefined, refineCandidates } from '../lib/refine.js'

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

/** 假的 llm 服务：按顺序吐给定的块。 */
const fakeLlm = (text, { fail = false } = {}) => ({
  async *stream() {
    if (fail) {
      yield { type: 'finish', reason: { kind: 'error' } }
      return
    }
    if (text !== '') yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
})
const fakeAgent = { options: { provider: 'p', model: 'm' } }

console.log('[1] 提示词的硬约束')

{
  const sys = buildRefineSystem({ owner: '树树' })
  ok(sys.includes('树树') === true, '提示词里用主人的称呼，不写"用户"')
  ok(sys.includes('没有信息量就输出空数组') === true, '明确允许「什么都不记」')
  ok(sys.includes('不要编') === true, '明确禁止编造')
  ok(sys.includes('JSON 数组') === true, '要求输出 JSON 数组')

  // ── 2026-10-30：判据换成「换一天、换一个话题仍然成立」──
  // 旧提示词的判据是「有没有信息量」，任务指令显然有信息量 → 被原样放行，
  // 项目卡里因此躺着三条「帮我改插件 / 对代码做最后检测 / 最近在排查 pwsh」。
  ok(sys.includes('换一天、换一个话题之后仍然成立') === true, '判据是「换个时间/话题仍成立」，不是「有信息量」')
  ok(sys.includes('帮我') && sys.includes('麻烦你') && sys.includes('请你') && sys.includes('给我'),
    '反例清单点了祈使句的触发词')
  for (const verb of ['检测', '修复', '实现', '重构', '提交', '推送']) {
    ok(sys.includes(verb) === true, `反例清单里有动作进度：「${verb}」`)
  }
  ok(sys.includes('最近在排查') && sys.includes('下一步要做'), '反例清单里有工作状态')
  ok(sys.includes('今天') && sys.includes('刚才') && sys.includes('这一轮'), '反例清单里有时间锚点')
  ok(sys.includes('只取人物信息') === true, '任务是任务、人物信息留下：只取人物信息')
  ok(sys.includes('晚上 11 点会上线跑图'), '习惯算该记的（举例给了长期习惯）')
  ok(sys.includes('kind 判据') === true, '输出要求里显式给出 kind 判据')
  ok(sys.includes('fact —— 客观事实') && sys.includes('preference —— 喜好厌恶') &&
    sys.includes('promise —— 约定') && sys.includes('event —— 一次性经历') &&
    sys.includes('feeling —— 稳定'), '五个 kind 的判据都写清了')
  ok(sys.includes('不许把') && sys.includes('当成记忆'), '最后一条底线：不许把「让我干什么」当记忆')

  const user = buildRefineUser([
    { text: '我今早七点多才起来' },
    { text: '我不敢吃辣' }
  ], { owner: '树树' })
  ok(user.includes('1. 我今早七点多才起来') === true, '原话按序号编号')
  ok(user.includes('2. 我不敢吃辣') === true, '第二条也在')

  const many = buildRefineUser(Array.from({ length: 20 }, (_v, i) => ({ text: `第 ${i} 句` })))
  ok(many.includes('9.') === false, '一次最多送 8 条（第 9 条不送）')
}

console.log('\n[2] 解析：模型输出不规范也要能读')

{
  const good = parseRefined('[{"text":"树树是烟台大学机器人工程专业大二学生","importance":85,"kind":"fact"}]')
  eq(good.length, 1, '标准数组')
  eq(good[0].text, '树树是烟台大学机器人工程专业大二学生', '正文保留')
  eq(good[0].importance, 85, '重要度保留')
  eq(good[0].kind, 'fact', 'kind 保留')

  const fenced = parseRefined('```json\n[{"text":"树树不敢吃辣","importance":70,"kind":"preference"}]\n```')
  eq(fenced.length, 1, 'markdown 代码块也能解析')

  const chatty = parseRefined('好的，这是提炼结果：\n[{"text":"树树英语从小就不好","importance":68,"kind":"fact"}]\n希望有帮助！')
  eq(chatty.length, 1, '前后带废话也能解析')

  const single = parseRefined('{"text":"树树目标是嵌入式工程师","importance":80,"kind":"fact"}')
  eq(single.length, 1, '只给一个对象也收')

  eq(parseRefined('[]').length, 0, '空数组 → 空（允许什么都不记）')
  eq(parseRefined('我提炼不出来'), null, '纯文字 → null（调用方退回原话）')
  eq(parseRefined(''), null, '空串 → null')
  eq(parseRefined(null), null, 'null → null')

  const messy = parseRefined(JSON.stringify([
    { text: '短', importance: 50 },            // 太短，丢
    { text: '树树打算明年考 CET-4', importance: 999, kind: '乱写' },
    { importance: 60 },                        // 没正文，丢
    null
  ]))
  eq(messy.length, 1, '坏条目被过滤，只留一条')
  eq(messy[0].importance, 100, '重要度夹到 100')
  eq(messy[0].kind, 'event', '未知 kind 归到 event')

  const overflow = parseRefined(JSON.stringify(Array.from({ length: 20 }, (_v, i) => ({
    text: `树树的事第${i}条`, importance: 50, kind: 'event'
  }))))
  ok(overflow.length <= 8, `一次最多 8 条（实际 ${overflow.length} 条）`)
}

console.log('\n[3] 调模型：失败必须返回 null')

{
  eq(await refineCandidates(null, fakeAgent, [{ text: '我不吃辣' }]), null, '没有 llm 服务 → null')
  eq(await refineCandidates({}, fakeAgent, [{ text: '我不吃辣' }]), null, 'llm 没有 stream → null')
  eq(await refineCandidates(fakeLlm(''), {}, [{ text: '我不吃辣' }]), null, '拿不到会话模型 → null')
  eq((await refineCandidates(fakeLlm(''), fakeAgent, [])).length, 0, '没有候选 → 空数组（不算失败）')

  const err = await refineCandidates(fakeLlm('', { fail: true }), fakeAgent, [{ text: '我不吃辣' }])
  eq(err, null, '模型报错 → null（调用方退回原话直存）')

  const junk = await refineCandidates(fakeLlm('我不知道该记什么'), fakeAgent, [{ text: '我不吃辣' }])
  eq(junk, null, '解析不出 JSON → null')

  const good = await refineCandidates(
    fakeLlm('[{"text":"树树不敢吃辣，一点辣都受不了","importance":70,"kind":"preference"}]'),
    fakeAgent,
    [{ text: '当然是不辣的。我不敢吃辣，有一点辣都受不了。' }]
  )
  eq(good.length, 1, '正常一路走通')
  eq(good[0].text, '树树不敢吃辣，一点辣都受不了', '返回的是提炼后的记忆，不是原话')
}

console.log('\n[4] 主人在场但不给 owner 也能跑')

{
  const fallback = await refineCandidates(
    fakeLlm('[{"text":"主人今天七点起床","importance":50,"kind":"event"}]'),
    fakeAgent,
    [{ text: '我今早七点多才起来' }]
  )
  eq(fallback.length, 1, '没传 owner 用默认称呼')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
