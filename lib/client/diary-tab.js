// ---- 摘录 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。
    // 可用：h / Card / apiGet / apiPost / apiPostDebounced / useState / useEffect / useCallback /
    //       timeLabel / cwdWithFallback。
    //
    // 设计要点（2026-11-21 / 0.10.0：由「日记」改成「摘录」）：
    //   · 一天一篇，正文是一行一条的事实条目
    //   · 旧日记（public/、private/）只读展示，标「旧日记」——不迁移、不删除
    //   · 手动触发可以带备注
    //   · 开关直接改 config（diaryEnabled）
    //
    // 摘录本用了几天：绑定当天算第 1 天，24 小时向上取整（跟后端 /state 的 sessionDays 同口径）
    function diaryDaysSince(bornAt) {
      var born = Number(bornAt)
      if (!Number.isFinite(born) || born <= 0) return 0
      var elapsed = Math.max(0, Date.now() - born)
      return Math.max(1, Math.ceil(elapsed / (24 * 60 * 60 * 1000)))
    }

    function DiaryTab(props) {
      var [data, setData] = useState(null)
      var [config, setConfig] = useState(props.state && props.state.config ? props.state.config : null)
      var [status, setStatus] = useState('')
      var [busy, setBusy] = useState('')
      var [noteText, setNoteText] = useState('')
      var [selectedDate, setSelectedDate] = useState('')
      // 摘录全文 / 旧日记全文：受控 state（2026-11-08 KNOWN-ISSUES #25，原来走 getElementById 直写 DOM）
      var [excerptText, setExcerptText] = useState('')
      var [reading, setReading] = useState(null)
      // 可选摘录会话（2026-11-04）：下拉选项来自 GET /diary/sessions
      var [sessions, setSessions] = useState([])
      var [sessionsLoading, setSessionsLoading] = useState(false)

      var load = useCallback(function () {
        apiGet('/diary/list?days=14')
          .then(function (res) { setData(res.list || []) })
          .catch(function (e) { setStatus('读取失败：' + e.message) })
      }, [])

      var loadSessions = useCallback(function () {
        setSessionsLoading(true)
        apiGet('/diary/sessions')
          .then(function (res) {
            setSessions(Array.isArray(res.sessions) ? res.sessions : [])
          })
          .catch(function (e) {
            setSessions([])
            setStatus('读取会话列表失败：' + e.message)
          })
          .then(function () { setSessionsLoading(false) })
      }, [])

      useEffect(function () { load() }, [load])
      useEffect(function () { loadSessions() }, [loadSessions])

      if (config === null) return h('div', { className: 'soul-empty' }, '正在加载…')

      function patch(next) {
        var base = config || {}
        var merged = {}
        Object.keys(base).forEach(function (k) { merged[k] = base[k] })
        Object.keys(next).forEach(function (k) { merged[k] = next[k] })
        setConfig(merged)
        // 2026-11-07 R8（P2-25/26）：
        //   ① 只把**改动过的键**发上去 —— 服务端 saveConfig 是按 key 合并的，
        //      发全量会让「另一个标签页刚改的项」被这份旧快照覆盖；
        //   ② 同一个输入框连续敲键只发最后一次（300ms 防抖）。
        var changed = {}
        Object.keys(next).forEach(function (k) {
          if (next[k] !== base[k]) changed[k] = next[k]
        })
        if (Object.keys(changed).length === 0) {
          setStatus('已保存，下一个回合生效')
          return
        }
        apiPostDebounced('config:diary', '/config', { config: changed }, 300)
          .then(function (result) {
            // 2026-11-10 R20-B（审查 M25）：被防抖合并掉的请求 resolve({merged:true})，
            // 它从没发出去 —— 不提示「已保存」也不刷新（真正发出的那次会走到这里）。
            if (result && result.merged === true) return
            setStatus('已保存，下一个回合生效')
            // 2026-11-08 KNOWN-ISSUES #22：保存成功后让 SoulSection 拉回最新 config，
            // 其余 Tab 的 props.config 不再停留在各自挂载时的旧快照。
            if (typeof props.reload === 'function') props.reload()
          })
          .catch(function (e) { setStatus('保存失败：' + e.message) })
      }

      function trigger() {
        var dateStr = selectedDate || ''
        var body = {}
        if (dateStr) body.date = dateStr
        if (noteText.trim()) body.note = noteText.trim()
        setBusy('trigger')
        apiPost('/diary', body)
          .then(function (res) {
            setStatus(res.message || '已触发摘录写作')
            setNoteText('')
            load()
          })
          .catch(function (e) { setStatus('触发失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      function readDay(item) {
        setBusy('read')
        apiGet('/diary/read?date=' + encodeURIComponent(item.date))
          .then(function (res) {
            setReading(res)
            if (res.hasExcerpt) {
              setExcerptText(String(res.excerptContent || ''))
              setStatus(res.date + ' 的摘录（' + (Array.isArray(res.excerptLines) ? res.excerptLines.length : 0) + ' 条）')
              return
            }
            // 只有旧日记：公开篇只读展示；旧私密篇跟以前一样不出服务器
            if (res.legacy && res.legacy.hasPublic) {
              setExcerptText(String(res.legacy.publicContent || ''))
              setStatus(res.date + ' 是旧日记（只读' + (res.legacy.hasPrivate ? '；旧私密篇不出服务器' : '') + '）')
              return
            }
            setExcerptText('')
            setStatus(res.date + ' 还没有摘录' + (res.legacy && res.legacy.hasPrivate ? '（只有旧私密日记，正文不出服务器）' : ''))
          })
          .catch(function (e) { setStatus('读取失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      // 选中下拉里的任意会话（2026-11-04）：把 id 交给后端存配置，成功后重拉列表。
      // 先乐观更新 select，失败时回滚 —— 否则受控 select 会在请求返回前弹回旧值。
      function bindSession(sessionId) {
        var id = String(sessionId || '').trim()
        if (id === '' || busy === 'bind' || id === (config.excerptSessionId || '')) return
        var previous = config
        var optimistic = {}
        Object.keys(previous).forEach(function (k) { optimistic[k] = previous[k] })
        optimistic.excerptSessionId = id
        setConfig(optimistic)
        setBusy('bind')
        apiPost('/diary/bind', { sessionId: id })
          .then(function (res) {
            if (res && res.config) setConfig(res.config)
            // 显示名字而不是 id：跟下拉同一个口径（sessionLabel 是函数声明，会提升）
            var boundId = String((res && res.sessionId) || id)
            var boundItem = sessions.filter(function (s) { return s && String(s.id) === boundId })[0] || { id: boundId, title: '' }
            setStatus('已绑定摘录会话：' + sessionLabel(boundItem).text)
            load()
          })
          .catch(function (e) {
            setConfig(previous)
            setStatus('绑定失败：' + e.message)
          })
          .then(function () { setBusy('') })
      }

      function unbind() {
        setBusy('unbind')
        apiPost('/diary/unbind', {})
          .then(function (res) {
            if (res && res.config) setConfig(res.config)
            setStatus('已解绑：摘录触发时会跳过并记日志')
          })
          .catch(function (e) { setStatus('解绑失败：' + e.message) })
          .then(function () { setBusy('') })
      }

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

      function numRow(key, label, note, min, max, step) {
        return h('div', { className: 'soul-row' },
          h('span', { className: 'soul-grow' }, label),
          h('input', {
            className: 'soul-input',
            type: 'number',
            style: { maxWidth: 100 },
            min: min,
            max: max,
            step: step || 1,
            value: (config && config[key] != null) ? config[key] : '',
            onChange: function (e) {
              var v = Number(e.target.value)
              if (!isNaN(v)) patch({ [key]: v })
            },
          }),
          note ? h('p', { className: 'soul-note', style: { flex: '1 1 100%', margin: '2px 0 0' } }, note) : null
        )
      }

      var enabled = !config || config.diaryEnabled !== false
      var currentSessionId = String(config.excerptSessionId || '')
      var sessionOptions = sessions.filter(function (item) { return item && String(item.id || '') !== '' })
      // 绑定的会话可能已经不在列表里（归档 / 服务暂时拿不到）：补一条，保证 select 能显示当前值
      if (currentSessionId !== '' && !sessionOptions.some(function (item) { return item.id === currentSessionId })) {
        sessionOptions = [{ id: currentSessionId, title: '' }].concat(sessionOptions)
      }

      // 会话显示名（2026-11-04）：下拉里给人看的应该是会话名称，不是 id。
      // 后端已经把「标题 → 首条消息 → 占位文案」这条链走完了，这里只做三件事：
      //   · 有标题就用标题；
      //   · 占位文案「（空会话，没有消息）」原样显示，后面加个「（空）」，并整行调灰；
      //   · 极端情况下标题还是空（日志没落盘 / 太旧），退成「会话 前8位」——
      //     完整 id 只放 title 属性里，鼠标悬停能看到，方便排查。
      // ⚠️ 原生 <option> 只能放纯文本、装不下带样式的 span，所以「灰字」只能把
      //    整个 option 调灰；选中后下方那行摘要里才是真正的灰字标记。
      function sessionLabel(item) {
        var id = String((item && item.id) || '')
        var title = String((item && item.title) || '').trim()
        var empty = title === '（空会话，没有消息）'
        var text = title !== '' ? title : '会话 ' + id.slice(0, 8)
        return { id: id, text: text, empty: empty }
      }
      var currentBinding = currentSessionId === ''
        ? null
        : sessionLabel(sessionOptions.filter(function (item) { return item.id === currentSessionId })[0])
      var bookDays = diaryDaysSince(config.excerptSessionBornAt)
      var bookDaysOld = bookDays > 15

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },

        // ---- 状态 ----
        // 触发链路没变：开机看一眼昨天，没写就补；一直不关机的，看门狗定时兜底。
        h(Card, { title: '摘录' },
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '自动写摘录'),
              h('p', { className: 'soul-note' }, '开机时写前一天的那一篇（一天一篇，一行一条的事实）。关掉后不写，已有的摘录保留。')
            ),
            h('input', {
              type: 'checkbox',
              checked: enabled,
              onChange: function (e) { patch({ diaryEnabled: e.target.checked }) },
            })
          ),
          // 现实情境（2026-11-09 R19 / ④）：只喂素材一句背景，不进提示词主干。
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '现实情境（节日 / 久未聊）'),
              h('p', { className: 'soul-note' },
                '写摘录时带上「国庆 / 三天没聊了」这类背景事实；目的那段也会带一句很短的状态。'
                + '纯规则、不花模型；不进提示词主干（否则每轮上下文都会抖）。')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.situationEnabled !== false,
              onChange: function (e) { patch({ situationEnabled: e.target.checked }) },
            })
          ),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('span', { className: 'soul-grow' }, '兜底检查间隔'),
            h('input', {
              className: 'soul-input',
              style: { maxWidth: 120 },
              value: (config && config.diaryWatchdogMinutes) || 30,
              spellCheck: false,
              placeholder: '30',
              onChange: function (e) {
                const n = Number(e.target.value)
                if (Number.isFinite(n) && n > 0) patch({ diaryWatchdogMinutes: n })
              },
            }),
            h('p', { className: 'soul-note', style: { flex: '1 1 100%', margin: '2px 0 0' } },
              '单位分钟，默认 30。电脑一直不关机时，每隔这么久看一眼昨天写没写。只查文件在不在，几乎不花钱。')
          ),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '启动时补写缺失的摘录'),
              h('p', { className: 'soul-note' }, '如果昨天没写，启动时会补上昨天那一篇。')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.diaryCatchUp !== false,
              onChange: function (e) { patch({ diaryCatchUp: e.target.checked }) },
            })
          )
        ),

        // ---- 绑定摘录会话（2026-10-31；2026-11-04 改成任意会话下拉） ----
        // 自己 agents.create 出来的会话没有宿主标准工具集，写不出文件；
        // 所以这里只负责把「已有会话」的 id 存进配置，投递时只认这个 id。
        h(Card, { title: '摘录写进哪个会话', meta: '绑定已有会话，不自动创建' },
          h('p', { className: 'soul-note', style: { margin: '0 0 8px' } },
            currentBinding
              ? h('span', null,
                  '当前绑定：',
                  // title 属性挂完整 id：显示的是名字，排查时还找得到是哪个会话
                  h('span', { title: currentBinding.id }, currentBinding.text),
                  currentBinding.empty
                    ? h('span', { style: { color: '#8b949e' }, title: currentBinding.id }, '（空）')
                    : null
                )
              : '还没绑定摘录会话。选一个后，写摘录时会把话题投给它。'),
          h('div', { className: 'soul-row' },
            h('select', {
              className: 'soul-select',
              style: { flex: '1 1 240px', maxWidth: 420 },
              value: currentSessionId,
              disabled: busy === 'bind' || sessionsLoading,
              onChange: function (e) { bindSession(e.target.value) },
            },
              h('option', { value: '', key: '' },
                sessionsLoading ? '正在读取会话…' : (sessionOptions.length === 0 ? '（没有可用会话）' : '— 选择会话 —')),
              sessionOptions.map(function (item) {
                var label = sessionLabel(item)
                return h('option', {
                  value: item.id,
                  key: item.id,
                  // 悬停看完整 id：界面上只显示名字，排查时才需要整串
                  title: label.id,
                  style: label.empty ? { color: '#8b949e' } : undefined,
                }, label.empty ? label.text + '（空）' : label.text)
              })
            ),
            h('button', {
              className: 'soul-btn',
              disabled: sessionsLoading || busy === 'bind',
              onClick: loadSessions,
            }, sessionsLoading ? '刷新中…' : '刷新列表'),
            h('button', {
              className: 'soul-btn',
              disabled: busy === 'unbind' || busy === 'bind' || !currentSessionId,
              onClick: unbind,
            }, '解绑')
          ),
          currentSessionId && bookDays > 0
            ? h('p', {
                className: 'soul-note',
                style: { color: bookDaysOld ? '#ffb020' : undefined },
              }, '摘录本：用了 ' + bookDays + ' 天（建议 15 天换一个）')
            : null
        ),

        // ---- 语气 ----
        h(Card, { title: '语气' },
          textRow('diaryPublicTone', '摘录语气', '例：平实、只写事实', '留空 = 不额外要求。摘录只写事实，语气只影响叙述的口气')
        ),

        // ---- 手动触发 ----
        h(Card, { title: '手动触发' },
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('span', { style: { flex: '0 0 72px', fontSize: 12 } }, '日期'),
            h('input', {
              className: 'soul-input',
              style: { maxWidth: 140 },
              value: selectedDate,
              spellCheck: false,
              placeholder: 'YYYY-MM-DD（默认今天）',
              onChange: function (e) { setSelectedDate(e.target.value) },
            })
          ),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('span', { style: { flex: '0 0 72px', fontSize: 12 } }, '备注'),
            h('input', {
              className: 'soul-input',
              style: { maxWidth: 300 },
              value: noteText,
              spellCheck: false,
              placeholder: '可留空；会被加进摘录素材里',
              onChange: function (e) { setNoteText(e.target.value) },
            })
          ),
          h('div', { className: 'soul-row', style: { marginTop: 8 } },
            h('button', {
              className: 'soul-btn on',
              disabled: busy === 'trigger',
              onClick: trigger
            }, busy === 'trigger' ? '正在写…' : '现在写摘录'),
            h('p', { className: 'soul-note', style: { margin: 0 } }, '默认写今天，日期可以改')
          )
        ),

        // ---- 最近摘录（旧日记只读） ----
        h(Card, { title: '最近摘录', meta: '点「看全文」看那一天；标「旧日记」的是 0.10.0 之前的旧数据，只读' },
          data === null || data.length === 0
            ? h('div', { className: 'soul-empty' }, '还没有写过摘录')
            : h('div', { className: 'soul-list soul-list-fixed' }, data.map(function (item) {
              var isLegacy = item.legacy === true
              return h('div', { key: item.date, className: 'soul-item' },
                h('div', { className: 'soul-item-text' },
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    h('span', null, item.date),
                    item.hasExcerpt ? h('span', { className: 'soul-badge vivid' }, '摘录') : null,
                    isLegacy ? h('span', { className: 'soul-badge clear' }, '旧日记') : null
                  ),
                  item.preview ? h('p', { className: 'soul-note', style: { marginTop: 4 } }, item.preview.slice(0, 120) + (item.preview.length > 120 ? '…' : '')) : null
                ),
                h('div', null,
                  h('button', {
                    className: 'soul-btn',
                    style: { fontSize: 11, padding: '2px 8px' },
                    disabled: busy === 'read',
                    onClick: function () { readDay(item) }
                  }, '看全文')
                )
              )
            }))
        ),

        // ---- 摘录全文（旧日记也用这块显示，只读） ----
        h(Card, { title: '摘录全文', meta: reading && reading.legacy && !reading.hasExcerpt ? '旧日记 · 只读' : '只读' },
          h('textarea', {
            className: 'soul-textarea',
            style: { minHeight: 200, resize: 'vertical' },
            readOnly: true,
            value: excerptText,
            onChange: function () {},
            placeholder: '点「看全文」加载某一天的摘录',
          })
        ),

        // ---- 数值 ----
        h(Card, { title: '数值' },
          // 2026-11-04：摘录改成「先让她自己写，超时才兜底」之后，这条路要能关掉 ——
          // 关掉就是纯插件规则化提取，不往会话里投消息。
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '摘录由她自己写'),
              h('p', { className: 'soul-note' }, '开着：写摘录时把话题投给会话，让她用工具自己写，180 秒没写成再规则化兜底。关掉：直接用兜底。')
            ),
            h('input', {
              type: 'checkbox',
              checked: !config || config.diaryAgentWrite !== false,
              onChange: function (e) { patch({ diaryAgentWrite: e.target.checked }) },
            })
          ),
          numRow('excerptMaxLines', '最多几条', '超了优先留「约定 / 决定 / 时间 / 待办」（最多 3 条放最前面）', 5, 60),
          numRow('diaryBackfillDays', '参考天数', '写新摘录时读最近几天的旧摘录', 1, 14),
          numRow('diaryMaxConversationChars', '对话预算', '喂给模型的对话最多多少字（超了保留最近的一段）', 1000, 32000),
          h('p', { className: 'soul-note', style: { margin: '8px 0 6px' } }, '模型路由（留空 = 跟随会话模型）'),
          textRow('diarySummarizeProvider', 'provider', '例：deepseek'),
          textRow('diarySummarizeModel', 'model', '例：deepseek-chat')
        ),

        status ? h('p', { className: 'soul-meta' }, status) : null
      )
    }
