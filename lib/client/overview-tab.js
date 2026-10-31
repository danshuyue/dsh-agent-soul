// ---- 概览 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。可用：h / Card / Badge / 各标签常量。

    function OverviewTab(props) {
      var state = props.state
      if (state === null) return h('div', { className: 'soul-empty' }, '正在加载…')
      var mem = state.memory || {}
      var g = mem.global || {}
      var p = mem.project
      var purpose = state.purpose || {}
      var sources = (state.persona && state.persona.sources) || []
      var ratio = Math.round((g.ratio || 0) * 100)
      // 2026-10-31：「最近」那张卡要用的三样。都必须给默认值 ——
      // 少一个就是 undefined，React 渲染时整页白屏（问题库 Q37）。
      var mood = state.mood || null
      var diary = state.diary || null
      var config = state.config || {}

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(Card, { title: '这一刻生效了什么' },
          h('p', { className: 'soul-note' }, '人格来源：' + (sources.length === 0 ? '还没写人格文件' : sources.length + ' 份')),
          sources.length > 0
            ? h('div', { className: 'soul-list' }, sources.map(function (src, i) {
              return h('div', { key: i, className: 'soul-item' },
                h('span', { className: 'soul-item-text', style: { fontSize: 12 } }, src)
              )
            }))
            : h('p', { className: 'soul-note' }, '去「人格」标签写一份，或者在 ' + '~/.dsh/AGENT.md 里写'),
          h('p', { className: 'soul-meta' }, '合并模式：' + (state.persona && state.persona.mode === 'exclusive' ? '互斥（有项目就不注入全局）' : '叠加（项目覆盖同名小节，全局其余照常生效）') + ' · 正文 ' + ((state.persona && state.persona.chars) || 0) + ' 字')
        ),

        h(Card, { title: '记忆' },
          h('div', { className: 'soul-row', style: { marginBottom: 8 } },
            h('div', { className: 'soul-grow' },
              h('div', { className: 'soul-row' },
                h('span', { style: { fontWeight: 500 } }, String(g.count || 0) + ' 条'),
                h('span', { className: 'soul-pill' }, '固定 ' + (g.pinned || 0)),
                p ? h('span', { className: 'soul-pill' }, '本项目 ' + (p.count || 0)) : null
              ),
              h('div', { className: 'soul-meter', style: { marginTop: 6 } },
                h('div', { className: 'soul-meter-fill', style: { width: Math.min(100, ratio) + '%' } })
              ),
              h('p', { className: 'soul-meta' }, (g.chars || 0) + ' / ' + (g.warnChars || 0) + ' 字（' + ratio + '%）' + (g.level === 'ok' ? '' : ' · 该整理了'))
            )
          ),
          h('div', { className: 'soul-row', style: { gap: 6 } },
            Object.keys(g.byClarity || {}).filter(function (k) { return g.byClarity[k] > 0 }).map(function (k) {
              return h(Badge, { key: k, clarity: k }, CLARITY_LABEL[k] + ' ' + g.byClarity[k])
            })
          ),
          h('p', { className: 'soul-meta' }, '上次整理：' + (g.lastDecayDate || '还没跑过'))
        ),

        h(Card, { title: '心里惦记的事' },
          purpose.mood
            ? h('div', { className: 'soul-row' },
              h('span', { className: 'soul-pill' }, '状态：' + purpose.mood.label),
              h('span', { className: 'soul-pill' }, '待办 ' + (purpose.open || 0) + ' 件')
            )
            : null,
          (purpose.goals || []).length === 0
            ? h('p', { className: 'soul-note', style: { marginTop: 6 } }, '暂时没惦记什么。她答应过的事、没弄明白的事会自动长出来。')
            : h('div', { className: 'soul-list' }, (purpose.goals || []).slice(0, 5).map(function (goal) {
              return h('div', { key: goal.id, className: 'soul-item' },
                h('span', { className: 'soul-badge' }, KIND_LABEL[goal.kind] || '想试试'),
                h('span', { className: 'soul-item-text' }, goal.text)
              )
            })),
          h('div', { className: 'soul-row', style: { marginTop: 8 } },
            Object.keys(purpose.drives || {}).map(function (need) {
              var value = purpose.drives[need] || 0
              return h('div', { key: need, style: { flex: '1 1 100px', minWidth: 90 } },
                h('span', { className: 'soul-meta' }, NEED_LABEL[need] + ' ' + Math.round(value * 100)),
                h('div', { className: 'soul-meter', style: { marginTop: 3 } },
                  h('div', { className: 'soul-meter-fill', style: { width: Math.round(value * 100) + '%' } })
                )
              )
            })
          )
        ),

        // ---- 最近（2026-10-31 新增）----
        //
        // 原来要看「这一周心情怎么走的、日记写没写」，得在心情页和日记页之间来回切。
        // 这里并一块：心情一行、日记一行。不追求好看，只求一眼看完。
        h(Card, { title: '最近' },
          h('div', { className: 'soul-row', style: { padding: '4px 0' } },
            h('span', { className: 'soul-grow' }, '心情'),
            mood && typeof mood.mood === 'number'
              ? h('span', { className: 'soul-pill' }, '现在 ' + Math.round(mood.mood))
              : h('span', { className: 'soul-meta' }, '还没有记录'),
            mood && mood.peakLabel
              ? h('span', { className: 'soul-meta', style: { marginLeft: 8 } }, '高峰 ' + mood.peakLabel)
              : null
          ),
          mood && mood.note
            ? h('p', { className: 'soul-note', style: { margin: '2px 0 6px' } }, String(mood.note).slice(0, 80))
            : null,
          h('div', { className: 'soul-row', style: { padding: '4px 0', borderTop: '1px solid rgba(128,128,128,.15)' } },
            h('span', { className: 'soul-grow' }, '昨天那篇日记'),
            diary && diary.yesterdayDone
              ? h('span', { className: 'soul-pill' }, (diary.yesterday || '昨天') + ' 已写')
              : h('span', { className: 'soul-pill' }, (diary && diary.yesterday ? diary.yesterday : '昨天') + ' 还没写')
          ),
          h('p', { className: 'soul-meta' },
            '规则：开机时写前一天那篇；一直不关机的话，每 '
            + ((config && config.diaryWatchdogMinutes) || 30) + ' 分钟兜底看一眼。')
        )
      )
    }