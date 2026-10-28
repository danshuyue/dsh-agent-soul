/**
 * facts.js —— 引擎的机制说明（给设置页展示用）。
 *
 * 为什么单独放一份数据：
 *   设置页要回答的不是「这个开关叫什么」，而是「打开它会发生什么」。
 *   把这段说明放在代码旁边，改引擎参数时不容易忘了同步文档；
 *   放在 README 里的话，几乎必然和实际行为漂移。
 */

export const MEMORY_FACTS = Object.freeze({
  clarity: [
    { key: 'vivid', label: '清晰', note: '完整记得细节，提示词里给满 200 字' },
    { key: 'clear', label: '清楚', note: '主干都在，压到 130 字' },
    { key: 'fuzzy', label: '模糊', note: '只记得大概，42 字 +「细节记不清了」' },
    { key: 'trace', label: '只剩印象', note: '只剩一句「好像有这件事」，提醒她别编' },
    { key: 'forgotten', label: '遗忘', note: '移出提示词，写进 archive.jsonl 存档' }
  ],
  rules: [
    { title: '一天只降一档', note: '所以是「慢慢模糊」，不是某天突然想不起来' },
    { title: '重要的事降得慢', note: '普通记忆每天 -0.35 的留存，和主人相关的只有 -0.12' },
    { title: '永远不会忘的', note: '固定的（pinned）和「第一次」类的事，永远清晰，压缩时也不淘汰' },
    { title: '提起来会变清楚', note: '被再次提及就刷新时间、召回次数 +1，一天回升一档' },
    { title: '太短的不记', note: '「嗯」「好的」不进记忆，省下的位置留给真有用的' },
    { title: '入库前脱敏', note: '密钥、手机号、身份证、卡号、链接会先抹掉再写盘' }
  ],
  budget: [
    { title: '记忆段每回合都重发', note: '它和工具 schema 一样是常驻成本，不进压缩。所以默认只给 1600 字' },
    { title: '中文比你以为的贵', note: 'DSH 按 4 字符/token 粗算，中文真实约 1.4~1.9 倍，1600 字大概 1100~1500 token' },
    { title: '超预算时整条剔除', note: '不会把一句话截成半个——按分区优先级从低到高一条条拿掉' }
  ],
  purpose: [
    { title: '目的是会衰减的', note: '四个维度各有驱动值，8 小时落一半，被聊到的东西又会推高' },
    { title: '惦记的事从记忆里长出来', note: '答应过的、没弄明白的、想试试的，会自动变成「心里惦记的事」' },
    { title: '不是定时问候', note: '本地没有推送渠道，所以「主动」= 主动想起，由她自己决定要不要提' }
  ]
})

export const CONFIG_FACTS = Object.freeze({
  mode: [
    { value: 'stack', label: '叠加（推荐）', note: '项目人格覆盖同名小节，全局的其余部分继续生效' },
    { value: 'exclusive', label: '互斥', note: '有项目人格时全局整份不注入（dsh-agent-md 的行为）' }
  ]
})
