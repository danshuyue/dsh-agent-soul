/**
 * persona.js —— 人格的三层文件模型（纯 node: 内置模块）。
 *
 * 三层，优先级从高到低：
 *   1. <cwd>/AGENT.md                        项目内人格（跟着仓库走，可提交进 git）
 *   2. <DSH_HOME>/agents/projects/<slug>.md  项目人格（本机存储，设置页编辑的那份）
 *   3. <DSH_HOME>/AGENT.md                   全局人格（所有会话的底座）
 *
 * ── 为什么这里和 dsh-agent-md 不一样 ──
 * 它是**互斥**的：只要找到项目人格，全局那份就整份不注入。
 * 后果就是 DSH 问题库 Q20 记录的那个坑 ——「写在全局 AGENT.md 的约定，
 * 某些工作区的会话完全不遵守」，而且现象像没读到一样，极难排查。
 *
 * 本插件的做法是**按小节合并**（stack 模式，默认）：
 *   · 两份人格按 `#` 标题切成小节；
 *   · 项目里有同名小节的，项目覆盖全局（保证「项目说了算」）；
 *   · 项目里没有的小节，全局的保留下来（保证全局约定到处都生效）。
 * 这样「这个项目里的特殊规则」和「我到哪里都这样的说话方式」不会互相吃掉。
 *
 * 想回到互斥行为：配置 mode: 'exclusive'。两种模式都能用，但默认是可解释的那个。
 *
 * ⚠️ 本文件只 import node: 内置模块。本地 link: 安装时 Node 以真实路径解析本插件，
 *   沿目录向上找不到 profile 的 node_modules，裸包名会解析失败。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { globalPersonaPath, readText, slugFor } from './paths.js'

/** 注入的正文上限（超出即截断并提示）。 */
export const MAX_INJECT_CHARS = 40000
/** 默认探测的项目内文件名。 */
export const LOCAL_NAMES = ['AGENT.md']

/**
 * 把 `{{xxx}}` 降级成 `{xxx}`。
 *
 * 为什么：DSH 把 `{{名字}}` 当模板变量，未注册的名字会让**整轮注入失败**。
 * 在人格文件里手滑写一个 `{{项目名}}` 就崩掉一整回合，而报错完全指不到这里。
 */
export function defuseTemplate(text) {
  return String(text ?? '').replace(/\{\{([^{}]{1,64})\}\}/g, '{$1}')
}

/**
 * 去掉 HTML 注释。
 *
 * 人格文件里的 `<!-- 例：这样写 -->` 是给人看的备注，不该进上下文：
 * 既省 token，也防止「例：……」这种示例被模型当成真实设定照做。
 */
export function stripComments(text) {
  return String(text ?? '').replace(/<!--[\s\S]*?-->/g, '')
}

/** 统一换行、去掉行尾空白、压掉连续空行。 */
export function tidy(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 清洗一份人格正文：去注释 → 降级模板变量 → 整理空白。 */
export function cleanPersona(text) {
  return tidy(defuseTemplate(stripComments(text)))
}

/**
 * 按 `#` 标题切小节。
 *
 * 只看一级标题（`# xxx`）作为切分单位：**二级标题跟着它的一级走**。
 * 理由是一级标题才是「主题」，`## 语气` 属于它所在的那个主题，
 * 拆到二级会让合并时出现「全局的 ## 语气」和「项目的 ## 语气」各自孤立。
 *
 * @returns {{ heading: string, body: string, text: string }[]}
 *   heading 为空串的那一段是标题之前的内容（前言）。
 */
export function splitSections(text) {
  const body = tidy(text)
  if (body === '') return []
  const lines = body.split('\n')
  const sections = []
  let heading = ''
  let buffer = []

  const flush = () => {
    const content = buffer.join('\n').trim()
    if (heading !== '' || content !== '') {
      sections.push({ heading, body: content, text: heading === '' ? content : `${heading}\n${content}`.trim() })
    }
    buffer = []
  }

  for (const line of lines) {
    if (/^#\s+\S/.test(line)) {
      flush()
      heading = line.trim()
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections.filter((section) => section.text !== '')
}

/**
 * 按小节合并两份人格：项目覆盖同名小节，全局的其余小节保留。
 *
 * 顺序：项目的小节排前面（更贴近当前任务），全局独有的追加在后面。
 * 前言（第一个标题之前的内容）如果两边都有，也按「项目优先」取一份。
 */
export function mergeSections(globalText, projectText) {
  const projectSections = splitSections(projectText)
  const globalSections = splitSections(globalText)
  if (projectSections.length === 0) return tidy(globalText)
  if (globalSections.length === 0) return tidy(projectText)

  const projectHeadings = new Set(projectSections.map((section) => section.heading).filter((h) => h !== ''))
  const kept = globalSections.filter((section) => section.heading === '' || !projectHeadings.has(section.heading))

  const merged = [...projectSections]
  for (const section of kept) {
    // 全局的前言并到项目前言里（项目前言在后，因为项目更具体）
    if (section.heading === '') {
      const projectPreamble = merged.find((item) => item.heading === '')
      if (projectPreamble !== undefined) projectPreamble.text = `${projectPreamble.text}\n\n${section.text}`.trim()
      else merged.push(section)
      continue
    }
    merged.push(section)
  }

  return merged.map((section) => section.text).join('\n\n').trim()
}

/** 项目内人格文件（cwd/AGENT.md，可配多个候选名）。 */
export function localPersonaPath(cwd, localNames = LOCAL_NAMES) {
  const dir = String(cwd ?? '').trim()
  if (dir === '') return null
  for (const name of Array.isArray(localNames) ? localNames : LOCAL_NAMES) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  return null
}

/** 项目人格（本机存储那份）的路径。 */
export function storedProjectPersonaPath(cwd) {
  return slugFor(cwd).personaPath
}

/**
 * 解析「这个会话该用哪几份人格」。
 *
 * @returns {{ project: {path,text,kind}|null, global: {path,text}|null }}
 *   project.kind: 'local'（cwd 里的 AGENT.md）| 'stored'（本机存储）
 */
export function resolveSources({ cwd = '', config = {} } = {}) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const useProject = cfg.projectPersonaEnabled !== false
  const localNames = Array.isArray(cfg.localNames) && cfg.localNames.length > 0 ? cfg.localNames : LOCAL_NAMES

  let project = null
  if (useProject && String(cwd).trim() !== '') {
    const localFile = localPersonaPath(cwd, localNames)
    if (localFile !== null) {
      project = { path: localFile, text: cleanPersona(readText(localFile)), kind: 'local' }
    } else {
      const storedFile = storedProjectPersonaPath(cwd)
      if (existsSync(storedFile)) {
        project = { path: storedFile, text: cleanPersona(readText(storedFile)), kind: 'stored' }
      }
    }
  }

  let global = null
  if (cfg.includeGlobal !== false) {
    const file = globalPersonaPath()
    if (existsSync(file)) global = { path: file, text: cleanPersona(readText(file)) }
  }

  return { project, global }
}

/**
 * 合成最终注入的人格正文。
 *
 * @returns {{ text: string, sources: string[], mode: string, truncated: boolean }}
 *   sources 是「这份内容来自哪些文件」，设置页要展示给用户看 ——
 *   「到底生效了没有」不该靠猜（这也是 Q20 那个坑的排查办法）。
 */
export function composePersona({ cwd = '', config = {} } = {}) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const mode = cfg.mode === 'exclusive' ? 'exclusive' : 'stack'
  const { project, global } = resolveSources({ cwd, config: cfg })
  const sources = []
  let text = ''

  if (project !== null && project.text !== '') {
    text = project.text
    sources.push(project.path)
  }

  if (global !== null && global.text !== '') {
    if (text === '') {
      text = global.text
      sources.push(global.path)
    } else if (mode === 'stack') {
      // 叠加：按小节合并，项目优先、全局补齐
      text = mergeSections(global.text, text)
      sources.push(`${global.path}（按小节叠加）`)
    }
    // exclusive 模式下全局整份不注入（跟 dsh-agent-md 行为一致，供需要时回退）
  }

  let truncated = false
  if (text.length > MAX_INJECT_CHARS) {
    text = `${text.slice(0, MAX_INJECT_CHARS)}\n\n（人格正文超过 ${MAX_INJECT_CHARS} 字，后面被截断了：长内容建议拆到别处，人格里只留指针。）`
    truncated = true
  }

  return { text, sources, mode, truncated }
}
