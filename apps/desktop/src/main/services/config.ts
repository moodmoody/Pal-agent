import { app, ipcMain } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 应用配置存储（主进程）。
 * 非敏感的用户配置（主题 / 语言 / 服务商与模型 / 默认模型等）以**明文 JSON** 存于
 * `~/.pal/config.json`，开发者可手改 / 备份 / 版本化（对标 ~/.claude）。
 * 根目录可用环境变量 `PAL_HOME` 覆盖（便携安装 / 测试 / CI）；旧名 `PAL_HOME` 仍识别，
 * 便于沿用既有脚本与便携包。
 * **敏感信息（API 密钥）绝不进此文件**——见 services/secrets.ts（safeStorage 加密的 secrets.json）。
 * 详见 docs/architecture/security.md。
 */

let home = ''

/** 迁移标记：写过就表示「已尝试过」，旧目录后来再出现也不再搬（避免用户故意回滚时被覆盖）。 */
const MIGRATED_FLAG = '.migrated-from-deva'

/**
 * 一次性把 `~/.deva` 复制到 `~/.pal`。
 *
 * 只在**目标目录不存在或为空**时执行，所以：
 *  - 全新安装：没有旧目录，什么也不做；
 *  - 从 Deva 升级：旧目录有数据、新目录还没建 → 整份复制；
 *  - 已经在用 Pal 产生数据：新目录非空 → 跳过，绝不覆盖用户现有数据。
 *
 * 复制而非移动：旧目录原样保留，用户确认没问题后自己删，出问题也能回退。
 * 迁移失败一律静默——最坏情况是用户看到空列表，而不是应用起不来。
 */
function migrateLegacyHome(target: string): void {
  try {
    const legacy = join(app.getPath('home'), '.deva')
    if (legacy === target) return
    if (!existsSync(legacy)) return
    if (existsSync(join(target, MIGRATED_FLAG))) return

    // 目标非空 = 用户已经在 Pal 上产生数据，不碰
    const occupied = existsSync(target) && readdirSync(target).length > 0
    if (!occupied) copyTree(legacy, target)
    writeFileSync(
      join(target, MIGRATED_FLAG),
      `from=${legacy}\nat=${new Date().toISOString()}\ncopied=${!occupied}\n`
    )
  } catch {
    /* 迁移是增强项，失败不影响启动 */
  }
}

/** 递归复制目录内容。符号链接 / 特殊文件跳过：配置目录里不该有，也不值得为它冒风险。 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    try {
      if (entry.isDirectory()) copyTree(src, dst)
      else if (entry.isFile()) copyFileSync(src, dst)
    } catch {
      /* 单个文件失败（占用 / 权限）就跳过，其余继续 */
    }
  }
}

/** Pal 配置根目录：PAL_HOME（或旧名 DEVA_HOME）覆盖，否则 ~/.pal。首次调用即确保目录存在并完成旧目录迁移。 */
export function getPalHome(): string {
  if (home) return home
  const override = process.env.PAL_HOME?.trim() || process.env.DEVA_HOME?.trim()
  home = override && override.length > 0 ? override : join(app.getPath('home'), '.pal')
  try {
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
  } catch {
    /* 目录创建失败：后续读写各自兜底，不阻断启动 */
  }
  // 只在没有环境变量覆盖时迁移：覆盖场景（便携 / CI）下用户自己指定了目录，不该被旧目录塞东西
  if (!override) migrateLegacyHome(home)
  return home
}

function configPath(): string {
  return join(getPalHome(), 'config.json')
}

let config: Record<string, unknown> = {}
let loaded = false

/** 同步载入（配置很小；同步读简化了首帧同步 IPC）。 */
function ensureLoaded(): void {
  if (loaded) return
  try {
    const raw = readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') config = parsed as Record<string, unknown>
  } catch {
    // 首次运行 / 文件不存在 / 解析失败 —— 视为空配置
    config = {}
  }
  loaded = true
}

function persist(): void {
  try {
    writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8')
  } catch {
    /* 持久化失败静默：不影响本次会话的内存态 */
  }
}

/**
 * 主进程内读取整份配置（只读快照）。
 * 供其它服务在进程内复用（如 git.ts 读 `git.path` 覆盖），避免各自重复读文件。
 */
export function getConfig(): Record<string, unknown> {
  ensureLoaded()
  return config
}

/**
 * 主进程内写配置（顶层浅合并，值为 undefined 时删除该键），并落盘。
 * 供 skills.ts / personas.ts 等服务在进程内维护启用态（config.json 内的 skills/personas 段），
 * 与渲染层的 `config:set` IPC 走同一份内存态 + 持久化路径。
 */
export function setConfig(patch: Record<string, unknown>): void {
  ensureLoaded()
  if (!patch || typeof patch !== 'object') return
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete config[k]
    else config[k] = v
  }
  persist()
}

export function registerConfigIpc(): void {
  ensureLoaded()

  // 同步读取整份配置：供渲染层首帧读取主题/语言，避免闪烁（FOUC）。
  ipcMain.on('config:get-sync', (evt) => {
    ensureLoaded()
    evt.returnValue = config
  })

  // 异步读取整份配置。
  ipcMain.handle('config:get', () => {
    ensureLoaded()
    return config
  })

  // 顶层浅合并补丁：值为 undefined 时删除该键。
  ipcMain.handle('config:set', (_e, patch: Record<string, unknown>) => {
    setConfig(patch)
    return { ok: true as const }
  })
}
