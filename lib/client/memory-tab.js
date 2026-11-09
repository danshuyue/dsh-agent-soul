// ---- 记忆 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。
    // 可用：h / Card / Badge / apiGet / apiPost / useState / useEffect / useCallback / CLARITY_LABEL。

    function MemoryTab(props) {
      var [scope, setScope] = useState('global')
      var [query, setQuery] = useState('')
      var [data, setData] = useState(null)
      var [status, setStatus] = useState('')
      var [draft, setDraft] = useState('')
      var cwd = cwdWithFallback(props)
      var config = props.config || {}

      function patchConfig(next) {
        // 2026-11-08 KNOWN-ISSUES #22：原来发「旧快照 + 改动键」的全量对象 ——
        // 服务端 saveConfig 按 key 合并，全量里的旧值会把别的 Tab 刚改的项盖掉。
        // 现在只发改动过的键（与 diary/mood/settings 的 R8 口径一致）。
        var changed = {}
        Object.keys(next).forEach(function (k) {
          if (next[k] !== config[k]) changed[k] = next[k]
        })
        if (Object.keys(changed).length === 0) return
        apiPost('/config', { config: changed })
          .then(function () { setStatus('配置已保存'); if (typeof props.reload === 'function') props.reload() })
          .catch(function (e) { setStatus('保存失败：' + e.message) })
      }

      // ---- 容量档位（2026-11-04，B6）----
      //
      // 为什么不给 9 个滑块：maxRecords 设成 5 的表现是「她什么都不记得了」，
      // 没有任何报错，用户根本不会把这两件事联系起来。数字型参数在设置页上
      // 只以档位出现，每组都是验证过的组合；真需要微调就改 persona.json。
      //
      // 切换后**不会立刻删东西**：这些参数在下一次例行维护（maintain）才被读到，
      // 所以「切到保守」不会当场触发压缩。UI 上写清楚，比加确认框有用 ——
      // 确认框点过一次就不看了。
      var PRESETS = {
        '保守': { recentDays: 14, fuzzyAfterDays: 14, forgetAfterDays: 90, minOwnerImportance: 75, maxRecords: 300, warnChars: 12000, autoCompact: true, maxPerTick: 8 },
        '标准': { recentDays: 7, fuzzyAfterDays: 7, forgetAfterDays: 60, minOwnerImportance: 65, maxRecords: 600, warnChars: 24000, autoCompact: true, maxPerTick: 12 },
        '激进': { recentDays: 5, fuzzyAfterDays: 5, forgetAfterDays: 30, minOwnerImportance: 55, maxRecords: 900, warnChars: 36000, autoCompact: true, maxPerTick: 20 }
      }

      function presetOf(cfg) {
        var names = Object.keys(PRESETS)
        for (var i = 0; i < names.length; i += 1) {
          var p = PRESETS[names[i]]
          var same = Object.keys(p).every(function (k) { return Number(cfg[k]) === Number(p[k]) })
          if (same) return names[i]
        }
        return '自定义'
      }

      var load = useCallback(function () {
        var url = '/memory?scope=' + scope + (cwd ? '&cwd=' + encodeURIComponent(cwd) : '') + (query ? '&query=' + encodeURIComponent(query) : '')
        apiGet(url).then(setData).catch(function (e) { setStatus('读取失败：' + e.message) })
      }, [scope, cwd, query])

      useEffect(function () {
        // 2026-11-07 R8 / P2-28：搜索框原来每敲一键就整页重取一次（后端还要全量打分）。
        // 带 query 时延迟 300ms 再取；scope/cwd 变化仍然立刻取（那是明确的切换动作）。
        if (query === '') { load(); return undefined }
        var timer = setTimeout(load, 300)
        return function () { clearTimeout(timer) }
      }, [load])

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
          : h('div', { className: 'soul-list soul-list-fixed' }, records.map(function (r) {
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
        h(Card, { title: '容量档位' },
          h('p', { className: 'soul-note' }, '当前：' + presetOf(config) + '。这一组决定「记多久、留多少、多久忘」；切换后不会立刻删东西，下一次例行维护时才生效。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
            Object.keys(PRESETS).map(function (name) {
              return h('button', {
                className: 'soul-btn' + (presetOf(config) === name ? ' on' : ''),
                onClick: function () {
                  patchConfig(PRESETS[name])
                  setStatus('已切到「' + name + '」，下次例行维护时生效（不会当场删记忆）')
                }
              }, name)
            })
          ),
          h('p', { className: 'soul-note', style: { marginTop: 6 } }, '想逐个数字调就改 persona.json —— 那些参数不放在界面上，是因为调坏了不会报错，只会「突然什么都不记得」。'),
          h('div', { className: 'soul-row', style: { marginTop: 10 } },
            h('span', { className: 'soul-grow' }, '告警字数'),
            h('input', {
              className: 'soul-input', type: 'number', style: { maxWidth: 110 },
              value: config.warnChars || 24000,
              onChange: function (e) { patchConfig({ warnChars: Number(e.target.value) || 24000 }) }
            })
          ),
          h('div', { className: 'soul-row' },
            h('span', { className: 'soul-grow' }, '每次整理最多动几条'),
            h('input', {
              className: 'soul-input', type: 'number', style: { maxWidth: 110 },
              value: config.maxPerTick || 12,
              onChange: function (e) { patchConfig({ maxPerTick: Number(e.target.value) || 12 }) }
            })
          ),
          h('div', { className: 'soul-row' },
            h('span', { className: 'soul-grow' }, '容量到顶时自动压缩'),
            h('input', {
              type: 'checkbox',
              checked: config.autoCompact !== false,
              onChange: function (e) { patchConfig({ autoCompact: e.target.checked }) }
            })
          ),
          h('p', { className: 'soul-note' }, '这三个可以单独调：调坏了最多是「提醒晚一点 / 整理慢一点 / 不自动整理」，都看得出来也能改回来。上面那组不行，所以只能选档位。')
        ),

        h(Card, { title: '记忆注入与整理' },
          h('div', { className: 'soul-row' },
            h('span', { className: 'soul-grow' }, '注入预算（字）'),
            h('input', {
              className: 'soul-input',
              type: 'number',
              style: { maxWidth: 110 },
              value: config.injectMaxChars || 3200,
              onChange: function (e) { patchConfig({ injectMaxChars: Number(e.target.value) || 3200 }) },
            })
          ),
          h('p', { className: 'soul-note' }, '这段**每回合重发**，是常驻成本。中文按 DSH 口径的 1.4~1.9 倍算：3200 字约 2200~3000 token。'),
          // 2026-10-30：注入从「整卡」改成「固定区 + 按当前这句话召回相关区」
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '按这句话召回相关记忆'),
              h('p', { className: 'soul-note' }, '开：固定区（开始 / 永远不会忘的）照旧，其余按你说的这句挑相关的；关：退回整张卡（老行为）')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.memoryRecall !== false,
              onChange: function (e) { patchConfig({ memoryRecall: e.target.checked }) },
            })
          ),
          h('div', { className: 'soul-row' },
            h('span', { className: 'soul-grow' }, '相关区召回条数'),
            h('input', {
              className: 'soul-input',
              type: 'number',
              style: { maxWidth: 110 },
              value: config.memoryRecallTopK ?? 6,
              onChange: function (e) { patchConfig({ memoryRecallTopK: Number(e.target.value) || 6 }) },
            })
          ),
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