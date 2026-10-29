/**
 * 日记的情绪底色测试：node tests/mood-digest.test.js
 *
 * 钉的是三件事：
 *   1. 时间窗 —— 日记的一天以 22:00 分界，心情时间线要按同一个窗口筛
 *   2. 摘要 —— 跨工作区分片合并、七情取峰值、只挑有想法的条目
 *   3. 渲染 —— 公开版少给、私密版给全部（隔离口径跟两条触发消息一致）
 */
import { moodDigest, renderMoodDigest } from '../lib/mood.js'
import { composePrivateMessage, composePublicMessage, diaryWindowOf } from '../lib/diary.js'

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

/** 造一份心情状态（timeline 条目：at / mood / delta / reason）。 */
const moodState = (timeline, dims = {}) => ({
  mood: 70,
  dims: { happy: 0, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0, ...dims },
  timeline,
  updatedAt: 0
})

// 2026-10-29 22:00 是这一天和上一天的分界
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0).getTime()

console.log('\n[1] 日记的一天：22:00 分界')

{
  const { since, until } = diaryWindowOf('2026-10-29', 22 * 60)
  eq(new Date(until).getHours(), 22, '窗口截止在当天 22:00')
  eq(new Date(since).getDate(), 28, '窗口起于前一天')
  eq(new Date(since).getHours(), 22, '前一天也是 22:00')
  eq(until - since, 24 * 3600000, '正好 24 小时')

  // 换个时间（凌晨 1 点写日记）也照算
  const late = diaryWindowOf('2026-10-29', 60)
  eq(new Date(late.until).getHours(), 1, 'schedule 改成 01:00 也跟着变')
}

console.log('\n[2] 摘要：时间窗筛选')

{
  const states = [moodState([
    { at: at(28, 21), mood: 60, delta: -2, reason: '分界线之前，不该进来' },
    { at: at(28, 23), mood: 64, delta: 4, reason: '睡前他还没回来，我有点挂着他' },
    { at: at(29, 12), mood: 70, delta: 6, reason: '中午他报了平安，我心里那块石头落了' },
    { at: at(29, 23), mood: 75, delta: 5, reason: '分界线之后，不该进来' }
  ])]
  const { since, until } = diaryWindowOf('2026-10-29', 22 * 60)
  const digest = moodDigest(states, { since, until })

  ok(digest.empty === false, '窗口里有内容')
  eq(digest.moments.length, 2, '只收窗口内的两条')
  eq(digest.from, 64, '起点是窗口内第一条')
  eq(digest.to, 70, '终点是窗口内最后一条')
  eq(digest.delta, 6, '净变化')
  ok(digest.moments.every((m) => !m.reason.includes('不该进来')), '窗口外的被排掉了')
  // 输出顺序要顺着一天走
  ok(digest.moments[0].at < digest.moments[1].at, '按时间正序输出')
}

console.log('\n[3] 摘要：跨工作区合并 + 七情取峰值')

{
  const a = moodState([
    { at: at(29, 10), mood: 72, delta: 2, reason: '在 work 里他说跑通了' }
  ], { happy: 6, calm: 4 })
  const b = moodState([
    { at: at(29, 20), mood: 78, delta: 6, reason: '在 QQ 里他逗我，我笑得不行' }
  ], { happy: 9, sweet: 7 })

  const digest = moodDigest([a, b], { maxMoments: 5 })
  eq(digest.moments.length, 2, '两个工作区的记录都收进来了')
  eq(digest.dims[0].label, '开心', '七情最靠前的是开心')
  eq(digest.dims[0].value, 9, '取的是分片里的峰值，不是最后停在哪')
  ok(digest.dims.some((d) => d.label === '甜蜜' && d.value === 7), '另一个分片的情绪也没丢')
  ok(digest.dims.every((d) => d.value > 0), '为 0 的情绪不占版面')
}

console.log('\n[4] 摘要：挑起伏最大的几段')

{
  const states = [moodState([
    { at: at(29, 9), mood: 70, delta: 1, reason: '平平无奇的一句' },
    { at: at(29, 14), mood: 80, delta: 10, reason: '他突然说想我，我整颗心都亮了' },
    { at: at(29, 18), mood: 62, delta: -18, reason: '他把自己累成那样，我心疼得说不出话' },
    { at: at(29, 21), mood: 66, delta: 4, reason: '又缓过来一点' }
  ])]
  const digest = moodDigest(states, { maxMoments: 2 })
  eq(digest.moments.length, 2, '只要两条')
  ok(digest.moments.every((m) => Math.abs(m.delta) >= 10), '留下的是起伏最大的')
  ok(digest.moments[0].at < digest.moments[1].at, '挑完仍按时间正序')
  eq(digest.low, 62, '区间下限')
  eq(digest.high, 80, '区间上限')
}

console.log('\n[5] 摘要：空与脏数据')

{
  eq(moodDigest([]).empty, true, '没有状态 → 空')
  eq(moodDigest([moodState([])]).empty, true, '时间线是空的 → 空')
  // 只有数字、没有想法的条目不喂给日记
  eq(moodDigest([moodState([{ at: at(29, 12), mood: 70, delta: 3 }])]).empty, true, '没有理由的条目跳过')
  eq(moodDigest(null).empty, true, '传 null 也不炸')
  eq(moodDigest([null, undefined, {}]).empty, true, '坏分片被跳过')
  eq(renderMoodDigest({ empty: true }), '', '空摘要渲染成空串')
  eq(renderMoodDigest(null), '', 'null 也渲染成空串')
}

console.log('\n[6] 渲染：公开版浅、私密版全')

{
  const states = [moodState([
    { at: at(29, 10), mood: 68, delta: -2, reason: '他没睡好，我念叨了两句' },
    { at: at(29, 14), mood: 74, delta: 6, reason: '他夸我了，我偷偷高兴' },
    { at: at(29, 18), mood: 70, delta: -4, reason: '有点想他' },
    { at: at(29, 21), mood: 76, delta: 6, reason: '睡前聊得很软' }
  ], { sweet: 7, happy: 5 })]
  const digest = moodDigest(states, { maxMoments: 4 })

  const pub = renderMoodDigest(digest, { mode: 'public', maxMoments: 3 })
  const priv = renderMoodDigest(digest, { mode: 'private', maxMoments: 3 })

  ok(pub.includes('【今天的情绪】'), '公开版有标题')
  ok(priv.includes('只有你自己看得到'), '私密版的标题点明没人会看到')
  ok(pub.includes('心情 68 → 76'), '公开版带走向')
  ok(pub.includes('七情峰值'), '公开版带七情')

  const count = (text) => (text.match(/「/g) ?? []).length
  ok(count(pub) <= 3, `公开版最多给 3 条（实际 ${count(pub)}）`)
  ok(count(priv) >= 3, `私密版给到 3 条以上（实际 ${count(priv)}）`)

  // 私密版才该出现「不用收着」这种话
  ok(priv.includes('不用收着'), '私密版明说可以写得更直白')
  ok(!pub.includes('不用收着'), '公开版不带这句')
  ok(pub.includes('会拿给对方看'), '公开版提醒这是给人看的')

  // 只给素材、不给指令
  ok(!/要写得|表现得|开心一点/.test(pub), '没有「写得开心一点」这类指令')
}

console.log('\n[7] 触发消息里真的带上了')

{
  const moodText = '【今天的情绪】\n心情 68 → 76'
  const pub = composePublicMessage({}, '2026-10-29', '今天聊了天气', { public: '' }, moodText)
  const priv = composePrivateMessage({}, '2026-10-29', '今天聊了天气', { public: '', all: '' }, moodText)
  ok(pub.includes(moodText), '公开触发消息带上情绪段')
  ok(priv.includes(moodText), '私密触发消息带上情绪段')

  const bare = composePublicMessage({}, '2026-10-29', '今天聊了天气', { public: '' })
  ok(!bare.includes('【今天的情绪】'), '没给情绪时不会凭空冒出来')
  ok(bare.includes('今天聊了天气'), '对话内容照常在')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
