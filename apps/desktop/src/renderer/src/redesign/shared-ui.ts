/**
 * 外壳层的小工具：路径短名、限长截断、平台判断。
 *
 * 这些函数在拆分后被多个面板共用（设置、任务、Git…），单独放一份，
 * 免得 A 面板 import B 面板只为拿一个字符串函数。
 */

/** 路径末段（文件名 / 目录名），去掉尾部斜杠。 */
export function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

/**
 * 嵌进纯文本标题（如删除确认框）的名字限长：超过 max 个字符截断补「…」。
 * 按码点切，不劈开 emoji 等代理对。确认框标题是拼好的整句，CSS 省略会连带吃掉句尾的「？」，故在文本层截断。
 */
export function clipName(s: string, max = 20): string {
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s
}

/** 是否 macOS（决定红绿灯按钮占位与快捷键符号）。 */
export const IS_MAC = window.Pal.platform === 'darwin'

/** 未绑定角色的会话按此 id 解析（内置通用助手）。 */
export const DEFAULT_PERSONA_ID = 'general'
