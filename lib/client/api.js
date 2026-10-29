// ---- 同源 API ---------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。与宿主只走同源 HTTP（/api/soul/*），
    // 不碰 RPC：浏览器半侧只要能 fetch 就能用，插件卸载/重装时页面顶多拿到 404。

    var API = '/api/soul'

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
    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }
    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
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

    /** ISO 时间 → 「10月26日 12:48」（设置页文件栏用）。 */
    function timeLabel(iso) {
      if (!iso) return ''
      var d = new Date(iso)
      if (isNaN(d.getTime())) return ''
      var pad = function (n) { return (n < 10 ? '0' : '') + n }
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }