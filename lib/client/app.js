// ---- 外壳 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。最后一个片段 —— 依赖前面所有的 Tab。
    // 可用：h / Dot / apiGet / cwdOf / ensureStyles / NS / useState / useEffect /
    //       useCallback / 六个 Tab 组件。

    function SoulSection(props) {
      var [tab, setTab] = useState('overview')
      var [state, setState] = useState(null)
      var [error, setError] = useState('')
      // 手选工作区覆盖：设置页是全局弹层，宿主经常不给 cwd —— 用户从下拉/任意目录挑一个后，全页跟着切
      var [cwdOverride, setCwdOverride] = useState('')
      var cwd = cwdOverride !== '' ? cwdOverride : cwdOf(props)

      var reload = useCallback(function () {
        apiGet('/state' + (cwd ? '?cwd=' + encodeURIComponent(cwd) : ''))
          .then(function (data) { setState(data); setError('') })
          .catch(function (e) { setError('读取失败：' + e.message + '（插件可能还没加载完）') })
      }, [cwd])

      useEffect(function () { reload() }, [reload])

      var tabs = [
        ['overview', '概览'],
        ['persona', '人格'],
        ['memory', '记忆'],
        ['purpose', '目的'],
        ['mood', '心情'],
        ['settings', '设置'],
      ]

      // 头部三个状态点：一眼看出哪里没配好
      var personaOk = Boolean(state && state.persona && state.persona.sources && state.persona.sources.length > 0)
      var memCount = state && state.memory && state.memory.global ? state.memory.global.count : 0
      var memRatio = state && state.memory && state.memory.global ? (state.memory.global.ratio || 0) : 0
      var memTone = memRatio >= 1 ? 'bad' : memRatio >= 0.8 ? 'warn' : 'ok'
      var goalCount = state && state.purpose ? state.purpose.open : 0
      var moodInfo = state && state.mood ? state.mood : null

      return h('div', { className: 'soul-app' },
        h('div', { className: 'soul-head' },
          h('div', null,
            h('p', { className: 'soul-kicker' }, 'agent soul'),
            h('h1', { className: 'soul-title' }, '灵魂'),
            h('p', { className: 'soul-sub' }, cwd === '' ? '当前没有工作目录 · 只用全局人格与全局记忆' : '工作目录：' + cwd)
          ),
          h('div', { className: 'soul-dots' },
            h(Dot, { tone: personaOk ? 'ok' : 'warn' }, personaOk ? '人格已注入' : '人格未配置'),
            h(Dot, { tone: memCount === 0 ? 'warn' : memTone }, memCount + ' 条记忆'),
            h(Dot, { tone: 'ok' }, goalCount + ' 件惦记'),
            h(Dot, { tone: moodInfo && moodInfo.mood >= 42 ? 'ok' : 'warn' }, '心情 ' + (moodInfo ? moodInfo.mood : '—'))
          )
        ),
        h('div', { className: 'soul-tabs' }, tabs.map(function (item) {
          return h('button', {
            key: item[0],
            className: 'soul-tab' + (tab === item[0] ? ' on' : ''),
            onClick: function () { setTab(item[0]) },
          }, item[1])
        })),
        h('div', { className: 'soul-body' },
          error ? h('p', { className: 'soul-err' }, error) : null,
          tab === 'overview' ? h(OverviewTab, { state: state, cwd: cwd }) : null,
          tab === 'persona' ? h(PersonaTab, {
            cwd: cwd,
            workspace: state && state.workspace,
            workspaces: state && state.workspaces,
            config: state && state.config,
            reload: reload,
            onSelectCwd: setCwdOverride,
          }) : null,
          tab === 'memory' ? h(MemoryTab, { cwd: cwd, config: state && state.config, reload: reload }) : null,
          tab === 'purpose' ? h(PurposeTab, { state: state, cwd: cwd, reload: reload }) : null,
          tab === 'mood' ? h(MoodTab, { cwd: cwd, state: state, reload: reload }) : null,
          tab === 'settings' ? h(SettingsTab, { state: state, cwd: cwd, reload: reload }) : null
        )
      )
    }

    /** 错误边界：设置页崩了要看得见原因，而不是整块白屏。 */
    function ErrorBoundary(props) {
      var [err, setErr] = useState(null)
      useEffect(function () {
        function onError(e) { setErr(e && e.message ? e.message : String(e)) }
        window.addEventListener('error', onError)
        return function () { window.removeEventListener('error', onError) }
      }, [])
      if (err !== null) {
        return h('div', { className: 'soul-app' },
          h('div', { className: 'soul-body' },
            h('div', { className: 'soul-card-h' }, h('p', { className: 'soul-card-t' }, '设置页出错了')),
            h('p', { className: 'soul-err' }, err),
            h('p', { className: 'soul-note' }, '这不影响人格与记忆本身，注入和记录都还在跑。可以点「继续」重试，或者重新加载页面。'),
            h('div', { className: 'soul-row', style: { marginTop: 10 } },
              h('button', { className: 'soul-btn', onClick: function () { setErr(null) } }, '继续'),
              h('button', { className: 'soul-btn', onClick: function () { window.location.reload() } }, '重新加载页面')
            )
          )
        )
      }
      return props.children
    }

    function apply(ctx) {
      if (typeof ctx.effect === 'function') ctx.effect(function () { return ensureStyles(ctx) }, NS + ': styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'soul',
          order: 47,
          locale: NS,
          label: function () { return '灵魂' },
        }, function (props) {
          var p = props !== null && props !== undefined ? props : {}
          return h(ErrorBoundary, null, h(SoulSection, p))
        })
      })
    }

    module.exports = { name: 'soul', inject: ['slots'], apply: apply }