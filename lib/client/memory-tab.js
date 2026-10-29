// ---- 记忆 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。
    // 可用：h / Card / Badge / apiGet / apiPost / useState / useEffect / useCallback / CLARITY_LABEL。

    function MemoryTab(props) {
      var [scope, setScope] = useState('global')
      var [query, setQuery] = useState('')
      var [data, setData] = useState(null)
      var [status, setStatus] = useState('')
      var [draft, setDraft] = useState('')
      var cwd = props.cwd
      var config = props.config || {}

      function patchConfig(next) {
        var merged = {}
        Object.keys(config).forEach(function (k) { merged[k] = config[k] })
        Object.keys(next).forEach(function (k) { merged[k] = next[k] })
        apiPost('/config', { config: merged })
          .then(function () { setStatus('配置已保存'); if (typeof props.reload === 'function') props.reload() })
          .catch(function (e) { setStatus('保存失败：' + e.message) })
      }

      var load = useCallback(function () {
        var url = '/memory?scope=' + scope + (cwd ? '&cwd=' + encodeURIComponent(cwd) : '') + (query ? '&query=' + encodeURIComponent(query) : '')
        apiGet(url).then(setData).catch(function (e) { setStatus('读取失败：' + e.message) })
      }, [scope, cwd, query])

      useEffect(function () { load() }, [load])

      function act(action, id, extra) {
        var body = { scope: scope, cwd: cwd, action: action, id: id }
        if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k] })
        apiPost('/memory', body)
          .then(function () { setStatus('已' + (action === 'delete' ? '删除' : action === 'pin' ? '固定' : '更新')); load() })
          .catch(function (e) { setStatus('操作失败：' + e.message) })
      }

      function add() {
        if (draft.trim() === '') return
        apiPost('/memory', { scope: scope, cwd: cwd, action: 'edit', id: '', text: draft })
          .catch(function () {
            // edit 需要 id，新增走 write：这里直接用 write 语义
            return apiPost('/memory', { scope: scope, cwd: cwd, action: 'write', text: draft })
          })
          .then(function () { setDraft(''); setStatus('记下了'); load() })
          .catch(function (e) { setStatus('添加失败：' + e.message) })
      }

      var records = (data && data.records) || []

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'soul-row' },
          h('button', { className: 'soul-btn' + (scope === 'global' ? ' on' : ''), onClick: function () { setScope('global') } }, '全局记忆'),
          h('button', { className: 'soul-btn' + (scope === 'project' ? ' on' : ''), onClick: function () { setScope('project') } }, '本项目'),
          h('input', {
            className: 'soul-input soul-grow',
            placeholder: '搜关键词',
            value: query,
            style: { maxWidth: 220 },
            onChange: function (e) { setQuery(e.target.value) },
          }),
          h('button', { className: 'soul-btn', onClick: load }, '刷新')
        ),
        h('p', { className: 'soul-meta' }, (data ? data.total : 0) + ' 条' + (status ? ' · ' + status : '')),

        h(Card, { title: '手动记一条' },
          h('div', { className: 'soul-row' },
            h('input', {
              className: 'soul-input soul-grow',
              placeholder: '写一件值得记住的事（会按重要度自动定衰减速度）',
              value: draft,
              onChange: function (e) { setDraft(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') add() },
            }),
            h('button', { className: 'soul-btn', onClick: add }, '记下来')
          ),
          h('p', { className: 'soul-note' }, '主人的偏好/目标、约定、"第一次"类的事会自动判高重要度，衰减得慢。')
        ),

        records.length === 0
          ? h('div', { className: 'soul-empty' }, query ? '没搜到' : '还没有记忆。多聊几句，值得记的会自动进来')
          : h('div', { className: 'soul-list' }, records.map(function (r) {
            return h('div', { key: r.id, className: 'soul-item' },
              h(Badge, { clarity: r.clarity }, CLARITY_LABEL[r.clarity] || r.clarity),
              h('div', { className: 'soul-item-text' },
                h('div', null, r.text),
                h('div', { className: 'soul-meta' },
                  '重要度 ' + r.importance +
                  ' · 提到过 ' + r.recallCount + ' 次' +
                  ' · ' + (r.source === 'auto' ? '自动记的' : r.source === 'tool' ? '她自己记的' : '手动') +
                  (r.pinned ? ' · 已固定' : '') +
                  (r.tags && r.tags.length ? ' · ' + r.tags.join('/') : '')
                )
              ),
              h('button', { className: 'soul-btn', onClick: function () { act('pin', r.id, { pinned: !r.pinned }) }, title: '固定后永不遗忘' }, r.pinned ? '取消固定' : '固定'),
              h('button', { className: 'soul-btn danger', onClick: function () { act('delete', r.id) } }, '删')
            )
          })),

        // ---- 记忆模块自己的配置（从「设置」页挪进来，模块化） ----
        h(Card, { title: '记忆注入与整理' },
          h('div', { className: 'soul-row' },
            h('span', { className: 'soul-grow' }, '注入预算（字）'),
            h('input', {
              className: 'soul-input',
              type: 'number',
              style: { maxWidth: 110 },
              value: config.injectMaxChars || 1600,
              onChange: function (e) { patchConfig({ injectMaxChars: Number(e.target.value) || 1600 }) },
            })
          ),
          h('p', { className: 'soul-note' }, '这段**每回合重发**，是常驻成本。中文按 DSH 口径的 1.4~1.9 倍算：1600 字约 1100~1500 token。'),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '注入记忆'),
              h('p', { className: 'soul-note' }, '关掉后记忆不再进提示词，但仍在后台记录')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.memoryEnabled !== false,
              onChange: function (e) { patchConfig({ memoryEnabled: e.target.checked }) },
            })
          ),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '项目记忆独立一张卡'),
              h('p', { className: 'soul-note' }, '关掉则所有记忆都进全局卡')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.projectMemoryEnabled !== false,
              onChange: function (e) { patchConfig({ projectMemoryEnabled: e.target.checked }) },
            })
          ),
          h('div', { className: 'soul-row', style: { marginTop: 8 } },
            h('button', {
              className: 'soul-btn',
              onClick: function () {
                setStatus('整理中…')
                apiPost('/maintain', { cwd: cwd })
                  .then(function (data) {
                    var r = data.report || {}
                    setStatus('整理完成：衰减 ' + (r.decayed || []).length + ' 张，压缩 ' + (r.compacted || []).length + ' 处')
                    if (typeof props.reload === 'function') props.reload()
                  })
                  .catch(function (e) { setStatus('失败：' + e.message) })
              }
            }, '立即整理一次')
          )
        )
      )
    }