// ---- 同源 API ---------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。与宿主只走同源 HTTP（/api/soul/*），
    // 不碰 RPC：浏览器半侧只要能 fetch 就能用，插件卸载/重装时页面顶多拿到 404。

    var API = '/api/soul'
    var TOKEN_HEADER = 'x-soul-token'

    // 2026-11-05 修 P0-1 余下：每个请求都要带会话令牌。
    // 默认由 /session 同源下发（进程内随机，重启即换）；宿主若能注入运行时值，
    // 可用 globalThis.__SOUL_API_TOKEN__ 配合服务端 DSH_SOUL_API_TOKEN 固定模式。
    var tokenValue = (typeof globalThis !== 'undefined' && typeof globalThis.__SOUL_API_TOKEN__ === 'string')
      ? globalThis.__SOUL_API_TOKEN__ : ''
    var tokenPending = null

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var err = new Error(data && data.error ? data.error : 'HTTP ' + res.status)
          err.status = res.status
          throw err
        }
        return data
      })
    }

    function timeoutSignal(ms) {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms)
      }
      return undefined
    }

    /** 拿会话令牌；并发的首次请求共用一个 Promise，避免首屏打出一排 /session。 */
    function bootstrapToken() {
      if (tokenPending !== null) return tokenPending
      var init = { method: 'GET', cache: 'no-store' }
      var signal = timeoutSignal(8000)
      if (signal) init.signal = signal
      tokenPending = fetch(API + '/session', init).then(readJson).then(function (data) {
        tokenValue = (data && typeof data.token === 'string') ? data.token : ''
        tokenPending = null
        return tokenValue
      }, function (error) {
        tokenPending = null
        throw error
      })
      return tokenPending
    }

    function withToken(init) {
      var opts = init || {}
      var headers = opts.headers || {}
      if (tokenValue !== '') headers[TOKEN_HEADER] = tokenValue
      else delete headers[TOKEN_HEADER]
      opts.headers = headers
      if (!opts.signal) {
        var signal = timeoutSignal(15000)
        if (signal) opts.signal = signal
      }
      return opts
    }

    /** 统一请求出口：首取令牌 → 带令牌请求 → 401 时换一次令牌重试（服务端重启）。 */
    function request(path, init, retried) {
      var ready = tokenValue !== '' ? Promise.resolve(tokenValue) : bootstrapToken()
      return ready.then(function () {
        return fetch(API + path, withToken(init))
      }).then(function (res) {
        if (res.status === 401 && !retried) {
          tokenValue = ''
          return request(path, init, true)
        }
        return readJson(res)
      })
    }

    function apiGet(path) {
      return request(path, { cache: 'no-store' }, false)
    }
    function apiPost(path, body) {
      return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }, false)
    }

    /** 从会话上下文里刨出 cwd —— 刨不到就全局视图，再不够还有服务端兜底与手选。 */
    function cwdOf(props) {
      var p = props || {}
      var candidates = [
        p.cwd,
        p.session && p.session.header && p.session.header.cwd,
        p.session && p.session.cwd,
        p.agent && p.agent.session && p.agent.session.header && p.agent.session.header.cwd,
      ]
      for (var i = 0; i < candidates.length; i += 1) {
        if (typeof candidates[i] === 'string' && candidates[i] !== '') return candidates[i]
      }
      return ''
    }

    /**
     * 服务端兜底出来的工作区（/state 里带回来的）。
     *
     * 2026-10-29：本页拿不到会话 cwd 时，各标签页原来各自拿着空串去请求，
     * 于是概览拿到 80、心情详情拿到空白 70 —— 同一个页面两个数字。
     * 服务端已经兜过底了，页面就把这个结果沿用下去，保证各标签页看的是同一份。
     */
    function serverCwdOf(props) {
      var ws = props && props.state && props.state.workspace
      return ws && typeof ws.cwd === 'string' ? ws.cwd : ''
    }

    /** 当前标签页该用的 cwd：页面自己有的优先，没有就沿用服务端兜底的那个。 */
    function cwdWithFallback(props) {
      var own = cwdOf(props)
      return own !== '' ? own : serverCwdOf(props)
    }

    /**
     * 当前会话 id（2026-10-31）。
     *
     * 设置页是全局弹层，这个 DSH 版本的 renderSlot('settings.section') 只传
     * { close }，所以 props 里通常没有会话；拿不到就返回空串，由后端
     * /diary/bind 兜底成「最近更新的会话」，绑定结果会回显 id 供核对。
     */
    function sessionIdOf(props) {
      var p = props || {}
      var candidates = [
        p.sessionId,
        p.session && p.session.header && p.session.header.id,
        p.session && p.session.id,
        p.agent && p.agent.session && p.agent.session.header && p.agent.session.header.id,
      ]
      for (var i = 0; i < candidates.length; i += 1) {
        if (typeof candidates[i] === 'string' && candidates[i] !== '') return candidates[i]
      }
      return ''
    }

    /** ISO 时间 → 「10月26日 12:48」（设置页文件栏用）。 */
    function timeLabel(iso) {
      if (!iso) return ''
      var d = new Date(iso)
      if (isNaN(d.getTime())) return ''
      var pad = function (n) { return (n < 10 ? '0' : '') + n }
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }