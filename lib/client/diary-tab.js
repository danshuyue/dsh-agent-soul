// ---- 日记 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。
    // 可用：h / Card / apiGet / apiPost / useState / useEffect / useCallback /
    //       timeLabel / cwdWithFallback。
    //
    // 设计要点：
    //   · 公开日记带预览，私密日记只显示存在性（不出服务器）
    //   · 手动触发可以带备注
    //   · 开关直接改 config（diaryEnabled）
    //
    // 日记本用了几天：绑定当天算第 1 天，24 小时向上取整（跟后端 /state 的 sessionDays 同口径）
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
      // 公开日记全文：受控 state（2026-11-08 KNOWN-ISSUES #25，原来走 getElementById 直写 DOM）
      var [publicText, setPublicText] = useState('')
      // 私密正文（2026-10-31）：只在 diaryPrivateVisible=true 且本机回环时取得到
      var [privateText, setPrivateText] = useState('')
      // 可选日记会话（2026-11-04）：下拉选项来自 GET /diary/sessions
      var [sessions, setSessions] = useState([])
      var [sessionsLoading, setSessionsLoading] = useState(false)
      // 「昨天想对今天说的」（2026-11-09 R19 / ⑥）：单条、当天有效
      var [toToday, setToToday] = useState(null)
      var [toTodayDraft, setToTodayDraft] = useState('')
      var [editingToToday, setEditingToToday] = useState(false)

      var load = useCallback(function () {
        apiGet('/diary/list?days=14')
          .then(function (res) {
            setData(res.list || [])
            setToToday(res.toToday || null)
          })
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
          .then(function () {
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
            setStatus(res.message || '已触发日记写作')
            setNoteText('')
            load()
          })
          .catch(function (e) { setStatus('触发失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      function readDay(dateStr) {
        setBusy('read')
        apiGet('/diary/read?date=' + encodeURIComponent(dateStr))
          .then(function (res) {
            // 2026-11-08 KNOWN-ISSUES #25：公开预览原来用 getElementById 直写 DOM
            // （绕过 React，固定 id 在宿主复用时还会撞车），改受控 state，与私密那份同口径。
            setPublicText(String(res.publicContent || ''))
            if (res.hasPrivate) {
              setStatus(config.diaryPrivateVisible === true
                ? res.date + ' 有私密日记，点「看私密」在本机查看'
                : res.date + ' 有私密日记（不出服务器，只能看文件）')
            } else {
              setStatus(res.date + ' 还没有日记')
            }
          })
          .catch(function (e) { setStatus('读取失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      // 私密日记正文（2026-10-31）：只有 diaryPrivateVisible=true 才允许点，
      // 后端还会再判一次「本机回环」。关着时按钮根本不渲染。
      function readPrivate(dateStr) {
        setBusy('private')
        apiGet('/diary/private?date=' + encodeURIComponent(dateStr))
          .then(function (res) {
            setPrivateText(res.content || '')
            var el = document.getElementById('soul-diary-private')
            if (el) el.value = res.content || ''
            setStatus(res.hasPrivate ? '已加载 ' + res.date + ' 的私密日记（仅本机可见）' : res.date + ' 没有私密日记')
          })
          .catch(function (e) { setStatus('读私密失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      // 选中下拉里的任意会话（2026-11-04）：把 id 交给后端存配置，成功后重拉日记列表。
      // 先乐观更新 select，失败时回滚 —— 否则受控 select 会在请求返回前弹回旧值。
      function bindSession(sessionId) {
        var id = String(sessionId || '').trim()
        if (id === '' || busy === 'bind' || id === (config.diarySessionId || '')) return
        var previous = config
        var optimistic = {}
        Object.keys(previous).forEach(function (k) { optimistic[k] = previous[k] })
        optimistic.diarySessionId = id
        setConfig(optimistic)
        setBusy('bind')
        apiPost('/diary/bind', { sessionId: id })
          .then(function (res) {
            if (res && res.config) setConfig(res.config)
            // 显示名字而不是 id：跟下拉同一个口径（sessionLabel 是函数声明，会提升）
            var boundId = String((res && res.sessionId) || id)
            var boundItem = sessions.filter(function (s) { return s && String(s.id) === boundId })[0] || { id: boundId, title: '' }
            setStatus('已绑定日记会话：' + sessionLabel(boundItem).text)
            load()
          })
          .catch(function (e) {
            setConfig(previous)
            setStatus('绑定失败：' + e.message)
          })
          .then(function () { setBusy('') })
      }

      // 「昨天想对今天说的」：改写 / 删掉（2026-11-09 R19 / ⑥）。
      // 两个都是**当天立刻生效** —— 首轮注入读的就是这个文件，改完下一次首轮就是新内容。
      function beginEditToToday() {
        setToTodayDraft(toToday && toToday.text ? toToday.text : '')
        setEditingToToday(true)
      }

      function saveToTodayEdit() {
        var text = String(toTodayDraft || '').trim()
        if (text === '') { setStatus('这句话不能是空的'); return }
        setBusy('toToday')
        apiPost('/diary/to-today', { action: 'edit', text: text })
          .then(function (res) {
            setToToday(res && res.toToday ? res.toToday : null)
            setEditingToToday(false)
            setStatus('已改写，今天的对话会用这一版')
          })
          .catch(function (e) { setStatus('改写失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      function deleteToToday() {
        setBusy('toToday')
        apiPost('/diary/to-today', { action: 'delete' })
          .then(function () {
            setToToday(null)
            setEditingToToday(false)
            setStatus('已删掉今天这句')
          })
          .catch(function (e) { setStatus('删除失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      function unbind() {
        setBusy('unbind')
        apiPost('/diary/unbind', {})
          .then(function (res) {
            if (res && res.config) setConfig(res.config)
            setStatus('已解绑：日记触发时会跳过并记日志')
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
      var currentSessionId = String(config.diarySessionId || '')
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
      var bookDays = diaryDaysSince(config.diarySessionBornAt)
      var bookDaysOld = bookDays > 15

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },

        // ---- 状态 ----
        // 2026-10-31 改：原来这里是「每天 22:00 到点触发」。
        // 但机器的开机时间不固定（可能一直不关，也可能几天不开），
        // 定点闹钟靠不住。现在改成「第二天写前一天的」：开机看一眼，
        // 昨天没写就补；一直不关机的，看门狗定时兜底。
        h(Card, { title: '日记' },
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '自动写日记'),
              h('p', { className: 'soul-note' }, '开机时写前一天的那一篇（生成公开 + 私密两篇）。关掉后不写，已有的日记保留。')
            ),
            h('input', {
              type: 'checkbox',
              checked: enabled,
              onChange: function (e) { patch({ diaryEnabled: e.target.checked }) },
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
              h('div', null, '启动时补写缺失的日记'),
              h('p', { className: 'soul-note' }, '如果昨天没写，启动时会补上昨天那一篇。')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.diaryCatchUp !== false,
              onChange: function (e) { patch({ diaryCatchUp: e.target.checked }) },
            })
          )
        ),

        // ---- 绑定日记会话（2026-10-31；2026-11-04 改成任意会话下拉） ----
        // 自己 agents.create 出来的会话没有宿主标准工具集，写不出文件；
        // 所以这里只负责把「已有会话」的 id 存进配置，投递时只认这个 id。
        h(Card, { title: '日记写进哪个会话', meta: '绑定已有会话，不自动创建' },
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
              : '还没绑定日记会话。选一个后，写日记时会把话题投给它。'),
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
              }, '日记本：用了 ' + bookDays + ' 天（建议 15 天换一个）')
            : null,
          h('div', { className: 'soul-row', style: { padding: '6px 0', marginTop: 8 } },
            h('div', { className: 'soul-grow' },
              h('div', null, '允许在本机设置页查看私密日记'),
              h('p', { className: 'soul-note' }, '默认关闭：私密只报「存在」，正文永不出服务器。开启后也只有 127.0.0.1 回环请求能读到正文。')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.diaryPrivateVisible === true,
              onChange: function (e) { patch({ diaryPrivateVisible: e.target.checked }) },
            })
          )
        ),

        // ---- 语气 ----
        h(Card, { title: '语气' },
          textRow('diaryPublicTone', '公开语气', '例：温暖但克制', '公开日记会拿给对方看，语气可以稍微收敛'),
          textRow('diaryPrivateTone', '私密语气', '例：真实、不设防', '私密日记只给自己看，可以放开写')
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
              placeholder: '可留空；会被加进日记素材里',
              onChange: function (e) { setNoteText(e.target.value) },
            })
          ),
          h('div', { className: 'soul-row', style: { marginTop: 8 } },
            h('button', {
              className: 'soul-btn on',
              disabled: busy === 'trigger',
              onClick: trigger
            }, busy === 'trigger' ? '正在写…' : '现在写日记'),
            h('p', { className: 'soul-note', style: { margin: 0 } }, '默认写今天，日期可以改')
          )
        ),

        // ---- 昨天想对今天说的（2026-11-09 R19 / ⑥）----
        // 只在功能开着时出现；今天没有这句就**不留空卡片**（不引导补写）——
        // 「没写就不写」是这个功能的规矩，UI 不该替她催更。
        config && config.diaryToTodayEnabled !== false && toToday
          ? h(Card, { title: '昨天想对今天说的', meta: '从私密日记里挑的、她愿意给你看的一句' },
            editingToToday
              ? h('div', null,
                h('input', {
                  className: 'soul-input',
                  value: toTodayDraft,
                  maxLength: 60,
                  onChange: function (e) { setToTodayDraft(e.target.value) }
                }),
                h('div', { className: 'soul-row', style: { marginTop: 8 } },
                  h('button', { className: 'soul-btn', disabled: busy === 'toToday', onClick: saveToTodayEdit }, '保存'),
                  h('button', { className: 'soul-btn', onClick: function () { setEditingToToday(false) } }, '取消')
                )
              )
              : h('div', null,
                h('p', { className: 'soul-note', style: { margin: '2px 0 8px' } }, toToday.date),
                h('p', { style: { fontSize: 15, margin: '0 0 10px', lineHeight: 1.6 } }, '「' + toToday.text + '」'),
                h('p', { className: 'soul-note' }, '今天每个新会话的第一轮会带上这一句；已开的会话不会变。'),
                h('div', { className: 'soul-row', style: { marginTop: 8 } },
                  h('button', { className: 'soul-btn', onClick: beginEditToToday }, '改写'),
                  h('button', { className: 'soul-btn', disabled: busy === 'toToday', onClick: deleteToToday }, '删掉')
                )
              )
            )
          : null,

        // ---- 最近日记 ----
        h(Card, { title: '最近日记', meta: '公开日记可直接看，私密日记不出服务器' },
          data === null || data.length === 0
            ? h('div', { className: 'soul-empty' }, '还没有写过日记')
            : h('div', { className: 'soul-list' }, data.map(function (item) {
              return h('div', { key: item.date, className: 'soul-item' },
                h('div', { className: 'soul-item-text' },
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    h('span', null, item.date),
                    item.hasPublic ? h('span', { className: 'soul-badge vivid' }, '公开') : null,
                    item.hasPrivate ? h('span', { className: 'soul-badge clear' }, '私密') : null
                  ),
                  item.preview ? h('p', { className: 'soul-note', style: { marginTop: 4 } }, item.preview.slice(0, 120) + (item.preview.length > 120 ? '…' : '')) : null
                ),
                h('div', null,
                  item.hasPublic ? h('button', {
                    className: 'soul-btn',
                    style: { fontSize: 11, padding: '2px 8px' },
                    disabled: busy === 'read',
                    onClick: function () { readDay(item.date) }
                  }, '看全文') : null,
                  item.hasPrivate && config.diaryPrivateVisible === true ? h('button', {
                    className: 'soul-btn',
                    style: { fontSize: 11, padding: '2px 8px', marginLeft: item.hasPublic ? 6 : 0 },
                    disabled: busy === 'private',
                    onClick: function () { readPrivate(item.date) }
                  }, '看私密') : null
                )
              )
            }))
        ),

        // ---- 公开日记预览 ----
        h(Card, { title: '公开日记全文' },
          h('textarea', {
            className: 'soul-textarea',
            style: { minHeight: 200, resize: 'vertical' },
            readOnly: true,
            value: publicText,
            onChange: function () {},
            placeholder: '点「看全文」加载某天的公开日记',
          })
        ),

        // ---- 私密日记全文（2026-10-31；开关关着就整块不渲染） ----
        config.diaryPrivateVisible === true ? h(Card, { title: '私密日记全文', meta: '仅本机回环可见' },
          h('textarea', {
            id: 'soul-diary-private',
            className: 'soul-textarea',
            style: { minHeight: 200, resize: 'vertical' },
            readOnly: true,
            value: privateText,
            onChange: function () {},
            placeholder: '点某一天的「看私密」加载',
          })
        ) : null,

        // ---- 数值 ----
        h(Card, { title: '数值' },
          // 2026-11-04：日记改成「先让她自己写，超时才兜底」之后，这条路要能关掉 ——
          // 关掉就是老的纯插件生成，不往会话里投消息。
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '日记由她自己写'),
              h('p', { className: 'soul-note' }, '开着：写日记时把话题投给会话，让她用工具自己写，180 秒没写成再兜底生成。关掉：直接由插件生成。')
            ),
            h('input', {
              type: 'checkbox',
              checked: !config || config.diaryAgentWrite !== false,
              onChange: function (e) { patch({ diaryAgentWrite: e.target.checked }) },
            })
          ),
          numRow('diaryBackfillDays', '参考天数', '写新日记时读最近几天的旧日记', 1, 14),
          numRow('diaryMaxConversationChars', '对话预算', '按分数挑多少字喂给模型（技术细节会被筛掉）', 1000, 32000),
          // 「摘要上限」(diaryMaxSummaryChars) 已于 2026-11-01 撤掉：
          // 日记主流程不再做摘要（摘要只吐 128 字、把半天内容压没了），
          // 这个旋钮改了没有任何效果，UI 却还在正常展示 —— 属于必须删的假旋钮。
          h('p', { className: 'soul-note', style: { margin: '8px 0 6px' } }, '摘要模型（留空 = 跟随会话模型）'),
          textRow('diarySummarizeProvider', 'provider', '例：deepseek'),
          textRow('diarySummarizeModel', 'model', '例：deepseek-chat')
        ),

        status ? h('p', { className: 'soul-meta' }, status) : null
      )
    }
