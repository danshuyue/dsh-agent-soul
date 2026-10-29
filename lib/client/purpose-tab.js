// ---- 目的 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。可用：h / Card / apiPost / NEED_LABEL / KIND_LABEL。

    function PurposeTab(props) {
      var state = props.state
      if (state === null) return h('div', { className: 'soul-empty' }, '正在加载…')
      var purpose = state.purpose || {}
      var drives = purpose.drives || {}

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(Card, { title: '此刻的状态' },
          h('p', { className: 'soul-note' }, '四个维度各有 0~100 的驱动值：8 小时落一半，聊到相关的东西会涨。她"想说点什么"的冲动就来自这里。'),
          h('div', { className: 'soul-list' },
            Object.keys(drives).map(function (need) {
              var value = drives[need] || 0
              return h('div', { key: need, className: 'soul-row' },
                h('span', { style: { width: 72, fontSize: 12 } }, NEED_LABEL[need] || need),
                h('div', { className: 'soul-meter soul-grow' },
                  h('div', { className: 'soul-meter-fill', style: { width: Math.round(value * 100) + '%' } })
                ),
                h('span', { className: 'soul-meta', style: { width: 32, textAlign: 'right' } }, String(Math.round(value * 100)))
              )
            })
          ),
          purpose.mood ? h('p', { className: 'soul-meta', style: { marginTop: 8 } }, '当前偏向：' + purpose.mood.label) : null
        ),
        h(Card, { title: '心里惦记的事（' + (purpose.open || 0) + ' 件）' },
          h('p', { className: 'soul-note' }, '这些会出现在她的提示词里，但明确写了「不需要每轮都提」——所以不会变成复读。'),
          (purpose.goals || []).length === 0
            ? h('div', { className: 'soul-empty' }, '暂时没有。她答应过的事、没弄明白的事会自动长出来')
            : h('div', { className: 'soul-list' }, (purpose.goals || []).map(function (goal) {
              return h('div', { key: goal.id, className: 'soul-item' },
                h('span', { className: 'soul-badge' }, KIND_LABEL[goal.kind] || '想试试'),
                h('div', { className: 'soul-item-text' },
                  h('div', null, goal.text),
                  h('div', { className: 'soul-meta' }, '权重 ' + goal.weight + ' · 来源 ' + (goal.source === 'memory' ? '从记忆里长出来的' : goal.source))
                ),
                h('button', {
                  className: 'soul-btn',
                  onClick: function () {
                    apiPost('/goal', { id: goal.id }).then(function () { props.reload() }).catch(function () {})
                  }
                }, '放下了')
              )
            }))
        ),

        // ---- 目的模块自己的开关（从「设置」页挪进来，模块化） ----
        h(Card, { title: '目的机制' },
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '启用「心里惦记的事」'),
              h('p', { className: 'soul-note' }, '从记忆里提炼没闭合的事，让她的主动有连续性。关掉后不再注入这一段')
            ),
            h('input', {
              type: 'checkbox',
              checked: !state.config || state.config.purposeEnabled !== false,
              onChange: function (e) {
                var config = state.config || {}
                var merged = {}
                Object.keys(config).forEach(function (k) { merged[k] = config[k] })
                merged.purposeEnabled = e.target.checked
                apiPost('/config', { config: merged })
                  .then(function () { props.reload() })
                  .catch(function () {})
              },
            })
          )
        )
      )
    }