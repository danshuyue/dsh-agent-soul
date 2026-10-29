// ---- 人格 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。
    // 可用：h / Card / Pill / Switch / apiGet / apiPost / useState / useEffect /
    //       useCallback / timeLabel。

    /**
     * 人格页 —— 布局照着 dsh-agent-md 的来（横幅 + 横向优先级条 + 药丸页签）。
     *
     * 为什么抄它的布局而不是自己另设计一套：
     *   用户在这个页面上已经形成肌肉记忆了 ——「本会话当前生效」在哪、页签在哪、
     *   打开原文件在哪。换插件时把这些位置全改掉，等于让人重新学一遍。
     *   差异只应该出现在**内容**上（叠加 vs 互斥、三层各自的路径与状态）。
     */
    function PersonaTab(props) {
      var workspace = props.workspace || null
      var config = props.config || {}
      var workspaces = props.workspaces || []
      // 项目人格不再灰：就算宿主没传 cwd，也能从下拉/任意目录里挑（学 dsh-agent-md）
      var [kind, setKind] = useState('global')
      var [text, setText] = useState('')
      var [path, setPath] = useState('')
      var [updatedAt, setUpdatedAt] = useState(null)
      var [status, setStatus] = useState('')
      var [loading, setLoading] = useState(false)
      var [busy, setBusy] = useState('')
      var [projectCwd, setProjectCwd] = useState('')
      var [pathDraft, setPathDraft] = useState('')
      var enabled = config.enabled !== false

      // 首帧之后把「宿主/服务端解析到的工作目录」种进 projectCwd（下拉默认选中它）
      useEffect(function () {
        if (projectCwd === '') {
          var seed = props.cwd || (workspace && workspace.cwd) || ''
          if (seed !== '') setProjectCwd(seed)
        }
      }, [props.cwd, workspace])

      // 正在编辑哪一份：全局不挑 cwd，项目用 projectCwd
      var effCwd = kind === 'project' ? projectCwd : ''

      var load = useCallback(function () {
        setLoading(true)
        setStatus('')
        apiGet('/persona?kind=' + kind + (effCwd ? '&cwd=' + encodeURIComponent(effCwd) : ''))
          .then(function (data) {
            setText(data.text || '')
            setPath(data.path || '')
            setUpdatedAt(data.updatedAt || null)
          })
          .catch(function (e) { setStatus('读取失败：' + e.message) })
          .then(function () { setLoading(false) })
      }, [kind, effCwd])

      useEffect(function () { load() }, [load])

      function save() {
        setStatus('保存中…')
        apiPost('/persona', { kind: kind, cwd: effCwd, text: text })
          .then(function (data) { setStatus('已保存（' + data.chars + ' 字），下一个回合生效') })
          .catch(function (e) { setStatus('保存失败：' + e.message) })
      }

      function openFile() {
        setStatus('正在打开…')
        apiPost('/open', { kind: kind, cwd: effCwd })
          .then(function () { setStatus('已在文件管理器中选中') })
          .catch(function (e) { setStatus(e.message) })
      }

      /** 让宿主弹系统「选择文件夹」，结果填进输入框（不直接切，防手滑）。 */
      function doPick() {
        setBusy('pick')
        apiPost('/pick', {})
          .then(function (res) {
            if (res && res.picked) {
              setPathDraft(res.picked)
              setStatus('已选中：' + res.picked + '（再点「使用」切过去）')
            } else {
              setStatus('取消选择')
            }
          })
          .catch(function (e) { setStatus('打不开选择器：' + e.message) })
          .then(function () { setBusy('') })
      }

      /** 用手填/选中的目录当工作区（登记 + 切过去 + 拉它的项目人格）。 */
      function usePickedCwd() {
        var cwd = pathDraft.trim()
        if (cwd === '') {
          setStatus('先填一个目录，或者点「选择文件夹」。')
          return
        }
        setBusy('pick')
        apiPost('/register', { cwd: cwd, active: true })
          .then(function () {
            setProjectCwd(cwd)
            setKind('project')
            if (typeof props.onSelectCwd === 'function') props.onSelectCwd(cwd)
            setStatus('已切到工作区：' + cwd)
          })
          .catch(function (e) { setStatus('登记失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      function toggleEnabled(next) {
        var merged = {}
        Object.keys(config).forEach(function (k) { merged[k] = config[k] })
        merged.enabled = next
        apiPost('/config', { config: merged })
          .then(function () {
            setStatus(next ? '已启用，下一个回合生效' : '已停用 —— 不会再注入任何人格')
            if (typeof props.reload === 'function') props.reload()
          })
          .catch(function (e) { setStatus('切换失败：' + e.message) })
      }

      var layers = (workspace && workspace.layers) || []
      var byLevel = {}
      layers.forEach(function (layer) { byLevel[layer.level] = layer })

      // 项目层实际生效的是哪一份（1 优先于 2）—— 结论由宿主算好，这里只负责显示
      var effProject = null
      if (workspace && workspace.projectEffective === 'local') effProject = byLevel[1]
      if (workspace && workspace.projectEffective === 'stored') effProject = byLevel[2]
      var effectiveText
      if (!enabled) effectiveText = '人格已停用 —— 当前不会注入任何人格'
      else if (effProject) effectiveText = effProject.name + ' · ' + effProject.path + '（＋叠加全局底座）'
      else if (byLevel[3] && byLevel[3].exists) effectiveText = '全局人格 · ' + byLevel[3].path
      else effectiveText = '尚未写入任何人格（写一份即生效）'

      /** 横向优先级条：每一步带「有 / 没有」，正在生效的那步加粗。 */
      function step(level) {
        var layer = byLevel[level]
        if (layer === undefined) return null
        var isEff = effProject !== null && effProject.level === level
          || (effProject === null && level === 3 && byLevel[3] && byLevel[3].exists && enabled)
        return h('span', {
          key: 'l' + level,
          className: 'soul-step' + (layer.exists ? ' on' : '') + (isEff ? ' eff' : ''),
          title: layer.path ? layer.path + '\n' + layer.scope : layer.scope,
        }, h('i', null), layer.name)
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 11 } },

        // ---- 头部：标题 + 总开关 ----
        h('div', { className: 'soul-row' },
          h('div', { className: 'soul-grow' },
            h('p', { className: 'soul-section-title' }, '人格 · AGENT.md'),
            h('p', { className: 'soul-note' }, '用 Markdown 写她是谁。项目里只写和其它项目不同的部分，其余从全局继承。')
          ),
          h(Switch, {
            checked: enabled,
            label: enabled ? '已启用' : '已停用',
            onChange: function (e) { toggleEnabled(e.target.checked) },
          })
        ),

        // ---- 横幅：本会话当前生效 / 当前工作目录 ----
        h('div', { className: 'soul-banner' },
          h('div', { className: 'soul-banner-line' },
            h('span', { className: 'soul-banner-key' }, '本会话当前生效'),
            h('span', { className: 'soul-banner-val' + (enabled && effectiveText.indexOf('尚未') === 0 ? ' warn' : '') }, effectiveText)
          ),
          h('div', { className: 'soul-banner-line' },
            h('span', { className: 'soul-banner-key' }, '当前工作目录'),
            h('span', { className: 'soul-banner-val' + (workspace && workspace.cwd ? '' : ' warn') },
              workspace && workspace.cwd
                ? workspace.cwd
                  + (workspace.cwdSource === 'recent' ? '（本页拿不到会话 → 用最近活跃工作区兜底）' : '')
                  + (workspace.cwdSource === 'path' ? '（手动指定）' : '')
                : '未解析到 —— 切到「项目人格」，从下面的工作区下拉或任意目录里挑一个')
          )
        ),

        // ---- 横向优先级条 ----
        layers.length > 0
          ? h('div', { className: 'soul-steps' },
            step(1),
            h('span', { className: 'soul-arrow' }, '›'),
            step(2),
            h('span', { className: 'soul-arrow' }, '›'),
            step(3),
            h('p', { className: 'soul-note', style: { flex: '1 1 100%', margin: '6px 0 0' } },
              '项目层取前两步里优先级最高的那一份；本插件再把全局底座按小节叠加上来（同名小节以项目为准）。')
          )
          : null,

        // ---- 覆盖警告 ----
        workspace && workspace.localOverridesStored
          ? h('div', { className: 'soul-warn-box' },
            '这个工作目录里有 AGENT.md，它的优先级高于「项目人格（本机）」。'
            + '你在下面第 2 层改的内容不会生效 —— 要么直接改那个文件，要么删掉它。'
          )
          : null,

        // ---- 页签与操作 ----
        h('div', { className: 'soul-row' },
          h(Pill, { active: kind === 'global', onClick: function () { setKind('global') } }, '全局人格'),
          h(Pill, {
            active: kind === 'project',
            onClick: function () { setKind('project') },
          }, '项目人格'),
          h('span', { className: 'soul-grow' }),
          h('button', { className: 'soul-btn', onClick: openFile, disabled: path === '' }, '打开原文件'),
          h('button', { className: 'soul-btn', onClick: load }, '重新读取'),
          h('button', { className: 'soul-btn on', onClick: save }, '保存')
        ),

        // ---- 项目专属：工作区下拉 + 任意目录（学 dsh-agent-md，不再依赖宿主传 cwd） ----
        kind === 'project' ? h('div', { className: 'soul-row' },
          h('span', { className: 'soul-row-label' }, '工作区'),
          workspaces.length > 0
            ? h('select', {
              className: 'soul-select',
              value: projectCwd,
              onChange: function (e) {
                var next = e.target.value
                setProjectCwd(next)
                if (typeof props.onSelectCwd === 'function') props.onSelectCwd(next)
              },
            }, workspaces.map(function (w) {
              var tags = []
              tags.push(w.exists === true ? '已有人格' : '空')
              if (w.sources && w.sources.indexOf('persona') >= 0) tags.push('已登记')
              return h('option', { key: w.key || w.cwd, value: w.cwd }, (w.displayName || w.cwd) + '（' + tags.join('·') + '） — ' + w.cwd)
            }))
            : h('span', { className: 'soul-note' }, '还没发现本机的工作区——下面手填一个目录即可。')
        ) : null,

        kind === 'project' ? h('div', { className: 'soul-row' },
          h('span', { className: 'soul-row-label' }, '任意目录'),
          h('input', {
            className: 'soul-input',
            value: pathDraft,
            spellCheck: false,
            placeholder: '例：D:\\team（也可以点右边用系统选择器挑）',
            onChange: function (e) { setPathDraft(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') usePickedCwd() },
          }),
          h('button', { className: 'soul-btn', onClick: doPick, disabled: busy === 'pick' }, '选择文件夹'),
          h('button', { className: 'soul-btn', onClick: usePickedCwd, disabled: busy === 'pick' }, '使用')
        ) : null,

        // ---- 文件栏：路径 + 上次改动 ----
        path !== '' ? h('div', { className: 'soul-filebar' },
          h('span', { className: 'soul-filebar-path', title: path }, path),
          h('span', null, updatedAt ? '上次改动 ' + timeLabel(updatedAt) : '文件尚未创建')
        ) : null,

        h('p', { className: 'soul-note' },
          kind === 'global'
            ? '全局是底座：所有会话都会吃到。项目里没有同名小节时，这里的内容照样生效。'
            : (projectCwd !== ''
              ? '只对上面那个工作目录生效。同名小节覆盖全局，其余自动继承。'
              : '先在上面选一个工作区，或者手填一个目录。')
        ),
        h('textarea', {
          className: 'soul-textarea',
          value: text,
          spellCheck: false,
          disabled: !enabled || (kind === 'project' && projectCwd === ''),
          placeholder: kind === 'global'
            ? '# 你是谁\n你是一个……\n\n# 语气与形态\n……\n\n# 工程约定\n……'
            : '# 工程约定\n这个项目用 ……，不要 ……\n\n（只写和其它项目不同的部分，其余从全局继承）',
          onChange: function (e) { setText(e.target.value) },
        }),
        h('p', { className: 'soul-meta' },
          text.length + ' 字' + (loading ? ' · 读取中' : '') + (status ? ' · ' + status : '')
        ),

        // ---- 人格模块自己的配置（从「设置」页挪进来，模块化） ----
        h(Card, { title: '人格注入设置' },
          h('div', { className: 'soul-row' },
            h('span', { className: 'soul-grow' }, '合并模式'),
            h('select', {
              className: 'soul-input',
              style: { maxWidth: 160 },
              value: config.mode === 'exclusive' ? 'exclusive' : 'stack',
              onChange: function (e) {
                var merged = {}
                Object.keys(config).forEach(function (k) { merged[k] = config[k] })
                merged.mode = e.target.value
                apiPost('/config', { config: merged })
                  .then(function () { setStatus('合并模式已保存'); if (typeof props.reload === 'function') props.reload() })
                  .catch(function (err) { setStatus('保存失败：' + err.message) })
              },
            },
              h('option', { value: 'stack' }, '叠加（推荐）'),
              h('option', { value: 'exclusive' }, '互斥')
            )
          ),
          h('p', { className: 'soul-note' }, '叠加 = 项目覆盖同名小节、全局其余照常生效；互斥 = 有项目人格时全局整份不注入（dsh-agent-md 的老行为）'),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '全局人格参与注入'),
              h('p', { className: 'soul-note' }, '关掉就变成「纯项目制」，没有项目人格的会话将没有人格')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.includeGlobal !== false,
              onChange: function (e) {
                var merged = {}
                Object.keys(config).forEach(function (k) { merged[k] = config[k] })
                merged.includeGlobal = e.target.checked
                apiPost('/config', { config: merged })
                  .then(function () { setStatus('已保存'); if (typeof props.reload === 'function') props.reload() })
                  .catch(function (err) { setStatus('保存失败：' + err.message) })
              },
            })
          ),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '启用项目人格'),
              h('p', { className: 'soul-note' }, '关掉只吃全局那份')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.projectPersonaEnabled !== false,
              onChange: function (e) {
                var merged = {}
                Object.keys(config).forEach(function (k) { merged[k] = config[k] })
                merged.projectPersonaEnabled = e.target.checked
                apiPost('/config', { config: merged })
                  .then(function () { setStatus('已保存'); if (typeof props.reload === 'function') props.reload() })
                  .catch(function (err) { setStatus('保存失败：' + err.message) })
              },
            })
          )
        )
      )
    }