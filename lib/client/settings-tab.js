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
        // 2026-11-07 R8（P2-25/26）：
        //   ① 只把**改动过的键**发上去 —— 服务端 saveConfig 是按 key 合并的，
        //      发全量会让「另一个标签页刚改的项」被这份旧快照覆盖；
        //   ② 同一个输入框连续敲键只发最后一次（300ms 防抖）。
        var changed = {}
        Object.keys(next).forEach(function (k) {
          if (next[k] !== config[k]) changed[k] = next[k]
        })
        if (Object.keys(changed).length === 0) {
          setStatus('已保存，下一个回合生效')
          return
        }
        apiPostDebounced('config:settings', '/config', { config: changed }, 300)
          .then(function (result) {
            // 2026-11-10 R20-B（审查 M25）：被防抖合并掉的请求没发出去，不提示不刷新
            if (result && result.merged === true) return
            setStatus('已保存，下一个回合生效')
            // 2026-11-08 KNOWN-ISSUES #22：同 diary-tab，保存成功后刷新全局快照
            if (typeof props.reload === 'function') props.reload()
          })
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

      // 2026-11-04：本页第一次需要文本输入，不再从心情页借 textRow。
      function textRow(key, label, placeholder, note) {
        return h('div', { className: 'soul-row' },
          h('span', { style: { flex: '0 0 72px', fontSize: 12 } }, label),
          h('input', {
            className: 'soul-input',
            style: { maxWidth: 220 },
            value: (config && config[key]) || '',
            spellCheck: false,
            placeholder: placeholder,
            onChange: function (e) { patch({ [key]: e.target.value }) },
          }),
          note ? h('p', { className: 'soul-note', style: { flex: '1 1 100%', margin: '2px 0 0' } }, note) : null
        )
      }

      // 性别只有三种取值（'' / male / female），用下拉比让人手打英文更不容易写错。
      function genderRow() {
        var options = [
          ['', '未设置'],
          ['male', '男生'],
          ['female', '女生'],
        ]
        return h('div', { className: 'soul-row' },
          h('span', { style: { flex: '0 0 72px', fontSize: 12 } }, '性别'),
          h('select', {
            className: 'soul-input',
            style: { maxWidth: 220 },
            value: config.ownerGender || '',
            onChange: function (e) { patch({ ownerGender: e.target.value }) },
          }, options.map(function (pair) {
            return h('option', { key: pair[0] || 'none', value: pair[0] }, pair[1])
          })),
          h('p', { className: 'soul-note', style: { flex: '1 1 100%', margin: '2px 0 0' } },
            '只用在心情判定提示词里「代词写错没写错」那一行。选「未设置」= 那一行整行不写。')
        )
      }

      var ownerMissing = !config.ownerName

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(Card, { title: '总开关' },
          toggle('enabled', '启用灵魂插件', '关掉后人格 / 记忆 / 目的 / 心情全部停摆，只剩设置页与工具（工具写的数据会留着）。'),
          h('p', { className: 'soul-note' }, '各模块的开关与参数在各自页签：人格 → 「人格」，注入预算与整理 → 「记忆」，惦记的事 → 「目的」，心情 → 「心情」，日记 → 「日记」。')
        ),

        // 2026-11-04：主人身份从「写死」改成「配置」。
        // 默认是空串 —— 陌生人装完不会被告知「你是树树的伴侣」；
        // 没填时下面有醒目提示，并且提示词里相关段落整句省略（不是留空壳）。
        h(Card, { title: '主人是谁' },
          ownerMissing
            ? h('div', {
              style: {
                margin: '4px 0 10px', padding: '8px 10px', borderRadius: 6,
                background: 'rgba(255,176,32,.14)', border: '1px solid #ffb020', fontSize: 13
              }
            }, '⚠️ 还没填名字：提示词里「关系 / 性别 / 称呼」这几句现在不注入，心情判定只用中性的「对方」。填上名字就会恢复。')
            : null,
          textRow('ownerName', '名字', '例：树树', '她平时怎么叫你。留空 = 相关段落整句不注入（记忆、笔记、日记照常）'),
          genderRow(),
          textRow('relationship', '关系', '例：伴侣 / 搭档 / 主人', '自由文本，会写成「你是「小糖」，是树树的…」。留空 = 不声明关系')
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