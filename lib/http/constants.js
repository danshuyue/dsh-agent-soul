/**
 * HTTP 接口 · constants.js
 * 由 lib/api.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { fileURLToPath } from 'node:url'


export const API_PREFIX = '/api/soul'


/**
 * 静态资源前缀：心情那五张表情图从这里出去（/dsh-agent-soul/face-ok.png）。
 * 跟 dsh-feiyu-mood 的老习惯一致，也避开宿主自己的路径。
 */
export const ASSET_PREFIX = '/dsh-agent-soul'


/** 只认这五张图 —— 白名单挡住 ../ 之类的路径穿越，别让外面翻目录。 */
export const FACE_ASSETS = new Set([
  'face-great.png',
  'face-good.png',
  'face-ok.png',
  'face-worry.png',
  'face-sad.png'
])


/** 插件自己的 assets 目录（跟 lib/ 平级；npm 装完也在那儿）。 */
// 文件从 lib/ 挪到 lib/http/ 后，相对 import.meta.url 要多退一级才回到仓库根
export const ASSETS_DIR = fileURLToPath(new URL('../../assets/', import.meta.url))


/** 请求体上限：设置页只传配置和短文本，1MB 足够，挡住手滑。 */
export const MAX_BODY = 1024 * 1024


/** 配置值校验的边界（2026-11-06 修 R6）。 */
export const CONFIG_STRING_MAX = 4096

/** 纯文件名：不含分隔符与 Windows 保留字符，长度 1~64。 */
export const CONFIG_NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,64}$/


/**
 * 弹一个系统「选择文件夹」对话框，返回选中的目录（取消返回空串）。
 *
 * 为什么要它：设置页里「项目人格」原本只能依赖宿主传 cwd，拿不到就整块灰死。
 * 浏览器拿不到原生目录选择器，所以这一步由宿主（Node 侧）代劳。
 * 三条平台分支各用系统自带工具，没有额外依赖。
 */
/** 系统对话框没人关时，Promise 原本永不 settle（P2-12）。 */
export const PICK_TIMEOUT_MS = 60_000
