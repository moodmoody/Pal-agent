/**
 * 发布仓库的唯一事实源。
 *
 * 检查更新（主进程 updater.ts）、工具 UA（services/tools.ts）、关于页的下载兜底链接
 * （shared/update.ts）都从这里取，不再各自硬编码。改名时只改本文件 + electron-builder.yml
 * 的 `publish.repo`，两处必须一致：electron-updater 读 builder 生成的那份配置，
 * 应用内「检查更新」读本文件，split 了就会出现「一边有新版、一边 404」。
 *
 * 注意：仓库真实存在前，检查更新会得到 404。这是预期的——见 updater.ts 对 404 的处理。
 */

export const REPO_OWNER = 'moodmoody'
export const REPO_NAME = 'Pal-agent'

/** 仓库主页。 */
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`

/** 所有版本的下载页：检查更新失败时给用户兜底。 */
export const RELEASES_URL = `${REPO_URL}/releases`

/** GitHub API：最新正式版（预发布不返回）。 */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
