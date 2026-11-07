/**
 * R2 / R3 / R4 回归（2026-11-06）。
 *
 * R2 `localNames` 可写 `../vault.txt` 把工作区外文件读进人格注入 —— persona.localPersonaPath 原来直接 join。
 * R3 DNS rebinding：宿主监听 127.0.0.1（netstat 实测），攻击者域名解析过来后浏览器认为同源，
 *    能读到 /session 的响应体拿到 token。判据是 Host 头。
 * R4 回环开关：HTTP 那条已经拦了，但配置文件里残留 false 仍会单独生效 —— 现在必须同时有启动环境变量。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'soul-r234-'))
process.env.DSH_HOME = home

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}`) }
}

const { localPersonaPath } = await import('../lib/persona.js')
const { isAllowedApiHost } = await import('../lib/core/api-token.js')
const { shouldAllowApiRequest } = await import('../lib/api.js')

const work = join(home, 'work')
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'AGENT.md'), '项目人格', 'utf8')
writeFileSync(join(home, 'vault.txt'), '工作区外的秘密', 'utf8')

console.log('R2 localNames 只收纯文件名：')
{
  ok(localPersonaPath(work, ['AGENT.md']) === join(work, 'AGENT.md'), 'AGENT.md 正常命中')
  ok(localPersonaPath(work, ['../vault.txt']) === null, '拒绝 ../vault.txt（工作区外）')
  ok(localPersonaPath(work, ['sub/AGENT.md']) === null, '拒绝带分隔符')
  ok(localPersonaPath(work, ['C:\\vault.txt']) === null, '拒绝绝对路径')
  ok(localPersonaPath(work, ['..']) === null, '拒绝 ..')
  ok(localPersonaPath(work, [null, 42, '', 'AGENT.md']) === join(work, 'AGENT.md'), '脏元素被跳过，合法的仍命中')
}

function reqWithHost(host, remote = '127.0.0.1') {
  return { headers: host === undefined ? {} : { host }, socket: { remoteAddress: remote } }
}

console.log('R3 Host 白名单：')
{
  ok(isAllowedApiHost(reqWithHost('127.0.0.1:57241')) === true, '放行 127.0.0.1:端口')
  ok(isAllowedApiHost(reqWithHost('localhost:3000')) === true, '放行 localhost:端口')
  ok(isAllowedApiHost(reqWithHost('[::1]:57241')) === true, '放行 [::1]:端口')
  ok(isAllowedApiHost(reqWithHost('localhost.')) === true, '放行 FQDN 尾点')
  ok(isAllowedApiHost(reqWithHost('evil.example.com')) === false, '拒绝外部域名（rebinding 场景）')
  ok(isAllowedApiHost(reqWithHost('127.0.0.1.evil.com')) === false, '拒绝后缀伪装')
  ok(isAllowedApiHost(reqWithHost(undefined)) === false, '没有 Host 头一律拒绝')
  process.env.DSH_SOUL_ALLOWED_HOSTS = 'soul.example.com'
  ok(isAllowedApiHost(reqWithHost('soul.example.com')) === true, '环境变量放行反代域名')
  delete process.env.DSH_SOUL_ALLOWED_HOSTS
  ok(isAllowedApiHost(reqWithHost('soul.example.com')) === false, '去掉环境变量后不再放行')
}

console.log('R4 回环门控下沉：')
{
  const lan = reqWithHost('127.0.0.1:1', '192.168.1.9')
  const loopback = reqWithHost('127.0.0.1:1', '127.0.0.1')
  ok(shouldAllowApiRequest(loopback, {}) === true, '回环请求放行')
  ok(shouldAllowApiRequest(lan, {}) === false, '非回环请求拒绝')
  ok(shouldAllowApiRequest(lan, { apiLoopbackOnly: false }) === false, '配置里写 false 单独不生效')
  process.env.DSH_SOUL_ALLOW_REMOTE_API = '1'
  ok(shouldAllowApiRequest(lan, { apiLoopbackOnly: false }) === true, '环境变量 + 配置 false 才放行')
  delete process.env.DSH_SOUL_ALLOW_REMOTE_API
  ok(shouldAllowApiRequest(lan, { apiLoopbackOnly: false }) === false, '撤掉环境变量立刻恢复拒绝')
}

console.log('清理：')
{
  try { rmSync(home, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
