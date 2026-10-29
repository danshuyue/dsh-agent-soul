// ---- 小组件 -----------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。可用：h / React。

    var CLARITY_LABEL = { vivid: '清晰', clear: '清楚', fuzzy: '模糊', trace: '只剩印象', forgotten: '已遗忘' }
    var NEED_LABEL = { curiosity: '想弄明白', care: '在乎', share: '想分享', mastery: '想搞懂' }
    var KIND_LABEL = { question: '想弄明白', promise: '答应过的', curious: '想试试', followup: '还没聊完' }
    // 七情顺序跟 lib/mood.js 的 DIMS 一致（界面按这个排）
    var MOOD_DIMS = [
      ['happy', '开心'], ['calm', '踏实'], ['sweet', '甜蜜'], ['heartache', '心疼'],
      ['worry', '担心'], ['sad', '难过'], ['jealous', '吃醋'],
    ]
    // 心情表情图的地址前缀：由 lib/api.js 的 registerAssets 注册出去（跟 ASSET_PREFIX 对齐）
    var MOOD_FACE_URL = '/dsh-agent-soul/face-'

    function Badge(props) {
      return h('span', { className: 'soul-badge ' + (props.clarity || '') }, props.children)
    }

    function Card(props) {
      return h('div', { className: 'soul-card' },
        props.title
          ? h('div', { className: 'soul-card-h' },
            h('p', { className: 'soul-card-t' }, props.title),
            props.meta ? h('span', { className: 'soul-card-m' }, props.meta) : null
          )
          : null,
        props.children
      )
    }

    /** 状态点：绿=正常、黄=要留意、红=有问题。 */
    function Dot(props) {
      return h('span', { className: 'soul-dot ' + (props.tone || '') },
        h('i', null),
        props.children
      )
    }

    /** 药丸页签（跟原人格插件一致的交互）。 */
    function Pill(props) {
      return h('button', {
        className: 'soul-pill-tab' + (props.active ? ' on' : ''),
        disabled: props.disabled === true,
        title: props.title || '',
        onClick: props.onClick,
      }, props.children)
    }

    /** 开关（带文字状态，比裸 checkbox 清楚）。 */
    function Switch(props) {
      return h('label', { className: 'soul-switch' },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: props.onChange,
        }),
        h('span', null, props.label)
      )
    }

    /** 一行键值（比裸 div 好读）。 */
    function Kv(props) {
      return h('div', { className: 'soul-kv' },
        h('span', null, props.label),
        h('b', null, props.value)
      )
    }