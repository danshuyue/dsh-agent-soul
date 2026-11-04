// ---- 设置 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。可用：h / Card / apiPost / useState / useEffect。
    //
    // 模块化之后这页只剩「跨模块」的项：总开关。
    // 各模块自己的配置在各自页签里（人格模式在人格页、注入预算在记忆页、心情参数在心情页）。
    function SettingsTab(props) {
      var [config, setConfig] = useState(props.state ? props.state.config : null)
      var [status, setStatus] = useState('')
      useEffect(function () {
        if (props.state && props.state.config) setConfig(props.state.config)
      }, [props.state])
      if (config === null) return h('div', { className: 'soul-empty' }, '正在加载…')

      function patch(next) {
        var merged = {}
        Object.keys(config).forEach(function (k) { merged[k] = config[k] })
        Object.keys(next).forEach(function (k) { merged[k] = next[k] })
        setConfig(merged)
        apiPost('/config', { config: merged })
          .then(function () { setStatus('已保存，下一个回合生效') })
          .catch(function (e) { setStatus('保存失败：' + e.message) })
      }

      function toggle(key, label, note) {
        return h('div', { className: 'soul-row', style: { padding: '6px 0' } },
          h('div', { className: 'soul-grow' },
            h('div', null, label),
            h('p', { className: 'soul-note' }, note)
          ),
          h('input', {
            type: 'checkbox',
            checked: config[key] !== false,
            onChange: function (e) { patch({ [key]: e.target.checked }) },
          })
        )
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(Card, { title: '总开关' },
          toggle('enabled', '启用灵魂插件', '关掉后人格 / 记忆 / 目的 / 心情全部停摆，只剩设置页与工具（工具写的数据会留着）。'),
          h('p', { className: 'soul-note' }, '各模块的开关与参数在各自页签：人格 → 「人格」，注入预算与整理 → 「记忆」，惦记的事 → 「目的」，心情 → 「心情」，日记 → 「日记」。')
        ),

        // 2026-11-04 补（B6）：这是全插件唯一的权限边界开关，之前没有任何界面 ——
        // 只有手改 persona.json 才生效，等于「有个安全开关但没人知道它在哪」。
        h(Card, { title: '接口权限' },
          toggle('apiLoopbackOnly', '只允许本机访问设置页接口',
            '开启时：只有 127.0.0.1 发来的请求才能改人格、写笔记、改配置。'
            + '关掉之后，本机任何进程（脚本、别的应用、浏览器扩展）都能直接调这些接口 —— '
            + '只有在宿主走代理、设置页被误拦时才需要关。'),
          h('p', { className: 'soul-note' },
            '被拒绝的请求会写进 soul.log，带真实来源地址。设置页打不开、日志里出现「拒绝非回环请求」，就是它拦的。')
        ),
        status ? h('p', { className: 'soul-meta' }, status) : null
      )
    }