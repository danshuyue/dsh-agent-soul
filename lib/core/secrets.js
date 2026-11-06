/**
 * secrets.js —— 插件自己的凭据存储（2026-11-01）
 *
 * 为什么要有这一层：朋友给的 API key 不能写在 persona.json 里。
 * 那个文件是明文、会被同步、会被整份贴进 issue；而 DSH 自己的
 * `.credentials.yaml` 的 refs 段也是明文（`DEEPSEEK_API_KEY: sk-...`）——
 * 插件不能假设宿主帮它兜底。
 *
 * 存储策略：
 *   · Windows → **DPAPI**（CurrentUser 范围）。密文绑当前用户账户，
 *     拷到别的机器/别的账户都解不开。这是这台机器上能拿到的最硬的保护。
 *   · 其他平台 → 退化成 base64 + 0600 权限，并在日志里**明确说这不是加密**。
 *     宁可说清楚，也不要让人以为拿了同等的保护。
 *
 * 注意：DPAPI 靠拉起一次 PowerShell 完成。**读和写都会拉起**（写时要加密、读时要解密），
 * 结果进内存缓存，所以每个 key 每个 DSH 进程最多各付一次 ~300ms。
 * 2026-11-06 审计 P1-6：原来这句写的是「只在读密钥时发生」，与实际不符，已改。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { delimiter as pathDelimiter, join } from 'node:path'
import { agentsDir, atomicWrite } from '../paths.js'
import { note } from '../env.js'

const CACHE = new Map()
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/
const DPAPI_PREFIX = 'dpapi:'
const PLAIN_PREFIX = 'plain:'

export const secretsDir = () => join(agentsDir(), 'secrets')
export const secretPath = (name) => join(secretsDir(), `${String(name).trim()}.bin`)

function safeName(name) {
  const value = String(name ?? '').trim()
  return NAME_RE.test(value) ? value : ''
}

/**
 * 跑一段 PowerShell，stdin 传数据（不把密钥放命令行参数里，进程列表里看不见）。
 *
 * 2026-11-06 审计 P1-6：原来硬编码 `'powershell'` 靠 PATH 解析，PATH 里没有就 ENOENT。
 * 2026-11-06 第二份审查 L-3：上一版的回退链**是断的**（我自己写的）：
 *
 *   for (const candidate of candidates) {
 *     if (!candidate.includes('\\') && !candidate.includes('/')) { return candidate }
 *     //  ↑ 'pwsh' 走到这里直接返回：既没验它存在，第三级 'powershell' 也永远不可达
 *
 * 现在每一项都必须**真的存在**才算：显式指定 → System32 → PATH 里的 pwsh → PATH 里的 powershell。
 */
const SHELL_ENV = 'DSH_SOUL_POWERSHELL'
let resolvedShell = null

/** 在 PATH 里按平台扩展名找一个可执行文件的绝对路径。找不到返回 ''。 */
function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  const dirs = String(process.env.PATH ?? '').split(pathDelimiter)
  for (const dir of dirs) {
    if (dir === '') continue
    for (const ext of exts) {
      const full = join(dir, name + ext)
      if (existsSync(full)) return full
    }
  }
  return ''
}

function powershellExe() {
  const tried = []

  // ① 显式指定：设了但不存在 → 直接报错，**不静默回退**
  //    （否则用户以为自己指定了，实际跑的是别的程序）
  //
  // 注意这里**不写缓存**：显式指定的值是环境变量，用户可能中途改掉或删掉。
  // 缓存住它的话，测试里那种「先指到 cmd.exe、再删掉变量」的序列会一直用着 cmd.exe
  // —— 实际排查问题时也会出现「改完环境变量还得重启」这种莫名其妙的症状。
  const explicit = String(process.env[SHELL_ENV] ?? '').trim()
  if (explicit !== '') {
    if (existsSync(explicit)) return explicit
    throw new Error(`${SHELL_ENV} 指向的路径不存在：${explicit}`)
  }

  // 下面这条链路的结果可以缓存（它只依赖机器上的固定安装位置）
  if (resolvedShell !== null) return resolvedShell

  // ② %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const builtin = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  tried.push(builtin)
  if (existsSync(builtin)) {
    resolvedShell = builtin
    return resolvedShell
  }

  // ③ PATH 里的 pwsh → ④ PATH 里的 powershell
  for (const name of ['pwsh', 'powershell']) {
    const found = onPath(name)
    tried.push(`${name} (PATH)`)
    if (found !== '') {
      resolvedShell = found
      return resolvedShell
    }
  }

  // 找不到**不缓存**：用户装完 PowerShell 之后，同进程内下一次调用要能成功
  throw new Error(`找不到可用的 PowerShell（试过：${tried.join('、')}），DPAPI 不可用`)
}

function powershell(script, input) {
  const exe = powershellExe()
  try {
    return execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      input,
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true
    }).trim()
  } catch (error) {
    // 这里一定要留痕：DPAPI 失败在旧实现里是彻底静默的，表现成「密钥存了但用不了」。
    note('secret', `PowerShell 调用失败（${exe}）：${error?.message ?? error}`)
    throw new Error(`系统加密组件不可用（找不到或跑不了 ${exe}）：${error?.message ?? error}`)
  }
}

function dpapiAvailable() {
  return process.platform === 'win32'
}

/**
 * 2026-11-06 R02/T4 顺带补的：PowerShell 的输出必须**看起来是 base64**，否则判失败。
 *
 * 起因是给回退链写测试时发现的：把 DSH_SOUL_POWERSHELL 指到 `cmd.exe`，
 * cmd 根本不认 `-Command` 的参数，退出码 0、stdout 空 —— 旧代码照样拿到空串，
 * 存成 `dpapi:`（空密文），`saveSecret` 还返回 ok:true。用户会得到一个
 * 「已保存、但永远解不开」的密钥，而且日志里只有「已用 DPAPI 加密保存」。
 *
 * 空输出 / 非 base64 一律当失败：宁可明确报错，也不要存一个解不开的密文。
 */
function assertCipherText(out, label) {
  const value = String(out ?? '').trim()
  if (value === '') {
    throw new Error(`${label}：PowerShell 没有输出（多半不是真正的 PowerShell），系统加密组件不可用`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`${label}：PowerShell 输出不是合法的 base64，系统加密组件行为异常`)
  }
  return value
}

function encrypt(text) {
  if (!dpapiAvailable()) {
    return PLAIN_PREFIX + Buffer.from(text, 'utf8').toString('base64')
  }
  const out = powershell(
    'Add-Type -AssemblyName System.Security;'
    + '$raw=[Console]::In.ReadToEnd().Trim();'
    + '$b=[Convert]::FromBase64String($raw);'
    + "$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');"
    + '[Convert]::ToBase64String($p)',
    Buffer.from(text, 'utf8').toString('base64')
  )
  return DPAPI_PREFIX + assertCipherText(out, 'DPAPI 加密')
}

function decrypt(stored) {
  if (stored.startsWith(DPAPI_PREFIX)) {
    if (!dpapiAvailable()) throw new Error('这份密钥是 Windows DPAPI 加密的，当前平台解不开')
    const out = powershell(
      'Add-Type -AssemblyName System.Security;'
      + '$raw=[Console]::In.ReadToEnd().Trim();'
      + '$b=[Convert]::FromBase64String($raw);'
      + "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');"
      + '[Convert]::ToBase64String($p)',
      stored.slice(DPAPI_PREFIX.length)
    )
    return Buffer.from(assertCipherText(out, 'DPAPI 解密'), 'base64').toString('utf8')
  }
  if (stored.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(stored.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
  }
  // 早期直接写 base64 的文件
  return Buffer.from(stored, 'base64').toString('utf8')
}

/**
 * 存一个密钥。**永远不回显明文**，只返回状态。
 * @returns {{ok: boolean, encrypted: boolean, path: string, error?: string}}
 */
export function saveSecret(name, value) {
  const key = safeName(name)
  if (key === '') return { ok: false, encrypted: false, path: '', error: '名字不合法（字母数字 . _ -）' }
  const text = String(value ?? '').trim()
  if (text === '') return { ok: false, encrypted: false, path: '', error: '密钥是空的' }
  try {
    // 2026-11-06 审计 P1-6：目录权限收紧到 0700，文件走统一原子写（tmp + rename + 0600）。
    // 原来是 mkdir（默认 0777 掩码）+ 直接 writeFileSync：崩溃会留半截密文，
    // 而且是符号链接就跟着写过去。atomicWrite 两个都解决。
    mkdirSync(secretsDir(), { recursive: true, mode: 0o700 })
    const file = secretPath(key)
    const written = atomicWrite(file, encrypt(text) + '\n')
    // atomicWrite 成功已带 0600；返回 ok:false 就是没写成，绝不能报「已保存」。
    if (written?.ok !== true) {
      note('secret', `${key} 写盘失败：${written?.error ?? '未知原因'}`)
      return { ok: false, encrypted: false, path: '', error: written?.error ?? '密钥写盘失败' }
    }
    if (!dpapiAvailable()) {
      try { chmodSync(file, 0o600) } catch { /* Windows 下不支持，忽略 */ }
      note('secret', `⚠️ ${key} 已保存，但当前平台没有系统级加密：文件是 base64 + 0600 权限，**不是真加密**`)
    } else {
      note('secret', `${key} 已用 DPAPI（CurrentUser）加密保存，明文不落盘`)
    }
    CACHE.set(key, text)
    return { ok: true, encrypted: dpapiAvailable(), path: file }
  } catch (error) {
    // 失败必须留一行日志：旧实现只 return {ok:false}，日志里一个字都没有。
    note('secret', `${key} 保存失败：${error?.message ?? error}`)
    return { ok: false, encrypted: false, path: '', error: String(error?.message ?? error) }
  }
}

/** 读密钥：环境变量优先（方便临时覆盖/CI），其次密文件。读不到返回 null。 */
export function loadSecret(name) {
  const key = safeName(name)
  if (key === '') return null
  if (CACHE.has(key)) return CACHE.get(key)
  const fromEnv = process.env[`SOUL_SECRET_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    CACHE.set(key, fromEnv.trim())
    return fromEnv.trim()
  }
  const file = secretPath(key)
  if (!existsSync(file)) return null
  try {
    const value = decrypt(readFileSync(file, 'utf8').trim())
    CACHE.set(key, value)
    return value
  } catch (error) {
    note('secret', `${key} 解不开：${error?.message ?? error}`)
    return null
  }
}

/** 只报告状态，绝不返回明文（设置页用）。 */
export function secretInfo(name) {
  const key = safeName(name)
  if (key === '') return { exists: false, encrypted: false, updatedAt: null }
  const file = secretPath(key)
  if (!existsSync(file)) {
    const envHit = typeof process.env[`SOUL_SECRET_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] === 'string'
    return { exists: envHit, encrypted: envHit, updatedAt: null, source: envHit ? 'env' : '' }
  }
  try {
    const raw = readFileSync(file, 'utf8').trim()
    return {
      exists: raw !== '',
      encrypted: raw.startsWith(DPAPI_PREFIX),
      updatedAt: statSync(file).mtimeMs,
      source: 'file'
    }
  } catch {
    return { exists: false, encrypted: false, updatedAt: null }
  }
}

export function deleteSecret(name) {
  const key = safeName(name)
  if (key === '') return false
  CACHE.delete(key)
  const file = secretPath(key)
  if (!existsSync(file)) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** 测试用：清掉内存缓存（文件不动）。 */
export function __resetSecretsForTest() {
  CACHE.clear()
}
