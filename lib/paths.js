/**
 * paths.js —— 所有文件路径的唯一来源（纯 node: 内置模块）。
 *
 * 为什么单独一个文件：
 *   路径散落在各处时，「全局记忆写哪儿」「项目记忆的 slug 怎么算」这类问题
 *   会在插件、测试、设置页三处给出三个答案。集中一处，改规则只改这里。
 *
 * 目录布局（跟 dsh-agent-md 保持兼容，便于从它平滑迁移）：
 *   <DSH_HOME>/AGENT.md                        全局人格（它已经在这写了，直接复用）
 *   <DSH_HOME>/agents/persona.json             本插件配置
 *   <DSH_HOME>/agents/projects/<slug>.md       项目人格（与 agent-md 同路径同规则）
 *   <DSH_HOME>/agents/memory/global.json       全局记忆卡
 *   <DSH_HOME>/agents/memory/projects/<slug>.json  项目记忆卡
 *   <DSH_HOME>/agents/memory/archive.jsonl     遗忘档案（append-only）
 *   <DSH_HOME>/agents/mood/<slug>.json         心情状态（按 cwd 的 slug；无 cwd 用 global）
 *
 * 为什么人格文件沿用它的路径而不是自己另起一套：
 *   他已经写好了 AGENT.md 和项目人格。换插件不该逼他搬家 ——
 *   路径一致意味着装上就能用，卸载也不丢东西。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** DSH 家目录：跟随 DSH_HOME 环境变量，否则 ~/.dsh（跟 DSH 自己的约定一致）。 */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

export const HOME = () => dshHome()
export const agentsDir = () => join(dshHome(), 'agents')
export const projectsDir = () => join(agentsDir(), 'projects')
export const memoryDir = () => join(agentsDir(), 'memory')
export const memoryProjectsDir = () => join(memoryDir(), 'projects')
export const globalPersonaPath = () => join(dshHome(), 'AGENT.md')
export const globalMemoryPath = () => join(memoryDir(), 'global.json')
export const archivePath = () => join(memoryDir(), 'archive.jsonl')
export const configPath = () => join(agentsDir(), 'persona.json')
export const injectLogPath = () => join(agentsDir(), 'inject-log.jsonl')
export const moodDir = () => join(agentsDir(), 'mood')

/** 心情状态路径：按 cwd 的 slug（跟人格/记忆同 slug，便于对照排查）；无 cwd 用 global。 */
export function moodPath(cwd) {
  const key = normalizePathKey(cwd)
  if (key === '') return join(moodDir(), 'global.json')
  return join(moodDir(), `${slugFor(cwd).slug}.json`)
}

/** 一次建齐所有目录（幂等）。 */
export function ensureDirs() {
  for (const dir of [agentsDir(), projectsDir(), memoryDir(), memoryProjectsDir(), moodDir()]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* 并发创建不算错误 */
    }
  }
}

/**
 * 路径归一：小写 + 正斜杠 + 去尾斜杠 + 去盘符大小写差异。
 * 目的只有一个 —— 同一个工作区在 Windows 上写法很多（D:\a\b、D:/a/b、d:\A\B），
 * 不归一就会产生好几份「同一个项目」的人格和记忆。
 */
export function normalizePathKey(cwd) {
  const raw = String(cwd ?? '').trim()
  if (raw === '') return ''
  return raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 8 位短哈希 —— **必须和 dsh-agent-md 的 hash8 完全一致（FNV-1a）**。
 *
 * 2026-10-28 真事故：这里原来用的是 sha1 前 8 位，看着"也能用"，但算出来的
 * 目录标识跟 dsh-agent-md **对不上**：
 *
 *   D:\DSH workspace\work
 *     dsh-agent-md (FNV-1a) → work-ea826e02   ← 他的人格文件在这
 *     本插件 (sha1)         → work-d8a72c47   ← 找一个不存在的文件
 *
 * 后果不是报错，是**静默认不出来**：设置页显示"项目人格：没有"，
 * 看起来像人格被弄丢了，其实文件好端端躺在原地；再点一下保存，
 * 还会在那个新 slug 下建出一份空人格，从此两份并存、各生效一半。
 *
 * 哈希算法没有"兼容性"可言 —— 换算法等于换一套命名空间。
 * 想改这里的实现，必须同时想清楚已有文件怎么办。
 */
export function shortHash(input) {
  const text = String(input ?? '')
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * cwd → slug。规则与 dsh-agent-md 完全一致（同一目录算出同一个 slug），
 * 这样它已经建好的项目人格文件能直接被本插件认领。
 */
export function slugFor(cwd) {
  const key = normalizePathKey(cwd)
  if (key === '') return { key: '', slug: 'global', fileName: 'global.md', personaPath: join(projectsDir(), 'global.md') }
  const tail = key.replace(/\/+$/, '').split('/').filter((part) => part !== '').pop() || 'root'
  // 只保留 ASCII 字母数字、汉字、连字符、下划线、点；其余一律换成 '-'
  const safe = tail.replace(/[^0-9a-zA-Z\u4e00-\u9fa5._-]/g, '-').slice(0, 40) || 'root'
  const slug = `${safe}-${shortHash(key)}`
  return { key, slug, fileName: `${slug}.md`, personaPath: join(projectsDir(), `${slug}.md`) }
}

/** 项目记忆卡路径（跟人格同 slug，便于对照排查）。 */
export function projectMemoryPath(cwd) {
  return join(memoryProjectsDir(), `${slugFor(cwd).slug}.json`)
}

/** 显示的目录名（设置页用）。 */
export function displayNameFor(cwd) {
  const key = normalizePathKey(cwd)
  if (key === '') return '（全局）'
  const tail = key.split('/').filter((part) => part !== '').pop() || key
  return tail
}

/**
 * 原子写：先写 .tmp 再 rename。
 *
 * 为什么不能直接 writeFileSync：
 *   记忆卡是每回合都可能被写的文件。DSH 被杀进程 / 断电时，
 *   半截 JSON 会让下次启动读到坏文件 —— 那一刻丢的是**全部记忆**，不是一条。
 *   rename 在同一分区上是原子的，最坏情况是丢掉最后一次写入，不会读到半个文件。
 */
export function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    // Windows 上目标被占用时 rename 会失败：退化成系统级拷贝覆盖（cp 不在 JS 堆里
    // 走一遍全量缓冲），至少不丢内容；记忆卡可达 MB 级，别再 readFileSync 读进内存。
    try {
      copyFileSync(tmp, file)
      unlinkSync(tmp)
    } catch {
      /* 都失败了就算了，调用方会在下次写入时再试 */
    }
  }
}

/** 读文本文件，不存在或读不了返回空串。 */
export function readText(file) {
  try {
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 是否存在。 */
export function exists(file) {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}
