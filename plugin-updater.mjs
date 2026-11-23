import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-host'
export const DEFAULT_UPDATE_INDEX_URL = 'https://raw.githubusercontent.com/jayujie/dsh-host/main/market-index.json'
export const DEFAULT_RELEASES_API_URL = 'https://api.github.com/repos/jayujie/dsh-host/releases/latest'
export const DEFAULT_REPO_URL = 'https://github.com/jayujie/dsh-host'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
const CACHE_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 8_000

let cachedVersion

export async function readPluginVersion() {
  if (cachedVersion) return cachedVersion
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  cachedVersion = String(pkg.version ?? '0.0.0')
  return cachedVersion
}

export function parseSemver(raw) {
  if (typeof raw !== 'string') return null
  const match = SEMVER_RE.exec(raw.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part)) : [],
  }
}

export function compareSemver(left, right) {
  const a = parseSemver(left), b = parseSemver(right)
  if (!a || !b) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  const ap = a.prerelease, bp = b.prerelease
  if (ap.length === 0 && bp.length === 0) return 0
  if (ap.length === 0) return 1
  if (bp.length === 0) return -1
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (i >= ap.length) return -1
    if (i >= bp.length) return 1
    if (ap[i] === bp[i]) continue
    const an = typeof ap[i] === 'number', bn = typeof bp[i] === 'number'
    if (an && bn) return ap[i] > bp[i] ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return ap[i] > bp[i] ? 1 : -1
  }
  return 0
}

function buildInstallSpec(entry) {
  const source = entry?.source
  if (!source || typeof source !== 'object') return undefined
  if (source.type === 'npm') return `${PACKAGE_NAME}@${entry.version}`
  if (source.type === 'git' && typeof source.url === 'string' && /^[0-9a-f]{40}$/.test(source.commit ?? '')) {
    const base = source.url.endsWith('.git') ? source.url : `${source.url}.git`
    const suffix = source.path ? `&path:/${source.path}` : ''
    return `git+${base}#${source.commit}${suffix}`
  }
  return undefined
}

async function fetchJson(fetchImpl, url, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'dsh-host-updater', ...headers },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchLatestRelease({
  indexUrl = DEFAULT_UPDATE_INDEX_URL,
  releasesApiUrl = DEFAULT_RELEASES_API_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  let indexError
  if (typeof indexUrl === 'string' && /^https?:\/\//i.test(indexUrl)) {
    try {
      const doc = await fetchJson(fetchImpl, indexUrl)
      if (doc?.format === 1 && Array.isArray(doc.plugins)) {
        const plugin = doc.plugins.find(item => item?.name === PACKAGE_NAME)
        const versions = Array.isArray(plugin?.versions) ? plugin.versions.filter(v => parseSemver(v?.version)) : []
        if (versions.length > 0) {
          versions.sort((a, b) => compareSemver(b.version, a.version))
          const latest = versions[0]
          const installSpec = buildInstallSpec(latest)
          return {
            latestVersion: latest.version,
            publishedAt: Number.isInteger(latest.publishTimestamp) ? latest.publishTimestamp * 1000 : undefined,
            sourceType: latest.source?.type ?? 'git',
            registry: latest.source?.registry,
            installSpec,
            releaseUrl: `${DEFAULT_REPO_URL}/releases/tag/v${latest.version}`,
            channel: 'market-index',
          }
        }
      }
      throw new Error('Market index does not list a valid dsh-host version')
    } catch (error) {
      indexError = error
    }
  }
  try {
    const release = await fetchJson(fetchImpl, releasesApiUrl, { 'X-GitHub-Api-Version': '2022-11-28' })
    const rawTag = String(release?.tag_name ?? '').trim()
    if (!parseSemver(rawTag)) throw new Error(`Invalid release tag: ${rawTag}`)
    const version = rawTag.replace(/^v/i, '')
    const tgz = Array.isArray(release.assets) ? release.assets.find(asset => /\.tgz$/i.test(asset?.name ?? '') && typeof asset?.browser_download_url === 'string') : undefined
    return {
      latestVersion: version,
      publishedAt: release.published_at ? Date.parse(release.published_at) : undefined,
      sourceType: tgz ? 'tarball' : 'git',
      installSpec: tgz?.browser_download_url ?? `git+${DEFAULT_REPO_URL}.git#v${version}`,
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : `${DEFAULT_REPO_URL}/releases/tag/v${version}`,
      notes: typeof release.body === 'string' ? release.body.slice(0, 2000) : undefined,
      channel: 'github-release',
    }
  } catch (releaseError) {
    throw new Error(indexError ? `检查更新失败：${indexError.message}；回退 GitHub Release 失败：${releaseError.message}` : `检查更新失败：${releaseError.message}`)
  }
}

export class PluginUpdater {
  #ctx
  #config
  #fetch
  #readVersion
  #cache
  #updating

  constructor(ctx, config = {}, { fetchImpl = globalThis.fetch, readVersion = readPluginVersion } = {}) {
    this.#ctx = ctx
    this.#config = config
    this.#fetch = fetchImpl
    this.#readVersion = readVersion
  }

  async #inspectInstalledBundle() {
    const manager = this.#ctx?.get?.('pluginManager')
    if (!manager || typeof manager.listBundles !== 'function') {
      return { manager: undefined, bundle: undefined, installMode: 'unknown', canAutoUpdate: false }
    }
    const bundles = await manager.listBundles()
    const bundle = Array.isArray(bundles) ? bundles.find(item => item?.name === PACKAGE_NAME) : undefined
    if (!bundle || !bundle.installed) {
      return { manager, bundle, installMode: 'unknown', canAutoUpdate: false }
    }
    const source = typeof bundle.source === 'string' ? bundle.source : ''
    if (source.startsWith('link:')) {
      return { manager, bundle, installMode: 'link', canAutoUpdate: false }
    }
    if (bundle.updatable === true) {
      return { manager, bundle, installMode: 'registry', canAutoUpdate: typeof manager.updateBundle === 'function' }
    }
    const canReplace = bundle.availability === 'profile' && bundle.removable !== false
      && typeof manager.removeBundle === 'function' && typeof manager.installBundle === 'function'
    return {
      manager,
      bundle,
      installMode: source.startsWith('file:') ? 'path' : 'git',
      canAutoUpdate: canReplace,
    }
  }

  async check({ refresh = false } = {}) {
    const currentVersion = await this.#readVersion()
    if (!refresh && this.#config.checkUpdates === false) {
      return {
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        disabled: true,
        canAutoUpdate: false,
        installMode: 'unknown',
        checkedAt: Date.now(),
      }
    }
    if (!refresh && this.#cache && Date.now() - this.#cache.checkedAt < CACHE_TTL_MS) {
      return this.#cache
    }
    const [latest, installed] = await Promise.all([
      fetchLatestRelease({
        indexUrl: this.#config.updateIndexUrl ?? DEFAULT_UPDATE_INDEX_URL,
        fetchImpl: this.#fetch,
      }),
      this.#inspectInstalledBundle().catch(() => ({ installMode: 'unknown', canAutoUpdate: false })),
    ])
    const updateAvailable = compareSemver(latest.latestVersion, currentVersion) > 0
    const result = {
      currentVersion,
      latestVersion: latest.latestVersion,
      updateAvailable,
      publishedAt: latest.publishedAt,
      sourceType: latest.sourceType,
      registry: latest.registry,
      installSpec: latest.installSpec,
      releaseUrl: latest.releaseUrl,
      notes: latest.notes,
      channel: latest.channel,
      installMode: installed.installMode,
      canAutoUpdate: updateAvailable && installed.canAutoUpdate && Boolean(latest.installSpec),
      checkedAt: Date.now(),
    }
    this.#cache = result
    return result
  }

  async apply({ version } = {}) {
    if (this.#updating) throw new Error('更新正在进行中，请稍候…')
    const task = this.#applyInner(version).finally(() => { this.#updating = undefined })
    this.#updating = task
    return task
  }

  async #applyInner(requestedVersion) {
    const status = await this.check({ refresh: true })
    if (!status.updateAvailable) {
      return {
        status: 'up-to-date',
        fromVersion: status.currentVersion,
        toVersion: status.latestVersion,
        message: `当前已是最新版本 v${status.currentVersion}。`,
      }
    }
    if (requestedVersion && requestedVersion !== status.latestVersion) {
      throw new Error(`目标版本 v${requestedVersion} 已过期，当前最新版本为 v${status.latestVersion}，请重新检查更新`)
    }
    const { manager, bundle, installMode, canAutoUpdate } = await this.#inspectInstalledBundle()
    if (installMode === 'link') {
      throw new Error('当前插件以本地 link: 开发目录挂载，请在本地仓库执行 git pull 后重启 DSH')
    }
    if (!canAutoUpdate || !manager || !status.installSpec) {
      throw new Error(`当前运行环境不支持自动更新，请前往插件页重新安装或访问 ${status.releaseUrl}`)
    }
    if (installMode === 'registry' && status.sourceType === 'npm' && typeof manager.updateBundle === 'function') {
      const outcome = await manager.updateBundle(PACKAGE_NAME, status.latestVersion, {
        ...(status.registry ? { registry: status.registry } : {}),
      })
      const app = outcome?.result?.application
      if (app === 'applied' || app === 'restart-required') {
        this.#cache = undefined
        return {
          status: app,
          fromVersion: status.currentVersion,
          toVersion: status.latestVersion,
          message: app === 'restart-required'
            ? `已更新至 v${status.latestVersion}，请完整重启 DSH（含系统托盘）使其生效。`
            : `已更新至 v${status.latestVersion}。`,
        }
      }
      throw new Error(outcome?.result?.error?.diagnostic ?? outcome?.result?.error?.code ?? '通过插件管理器更新失败，请查看插件日志')
    }
    // Git / Plugin Market / tarball installation: remove old bundle and install target pinned spec, rolling back on failure.
    const previousSource = bundle?.source
    const removal = await manager.removeBundle(PACKAGE_NAME)
    if (removal?.application === 'failed' || removal?.application === 'cancelled') {
      throw new Error(removal?.error?.diagnostic ?? removal?.error?.code ?? '卸载旧版本失败，未执行更新')
    }
    const install = await manager.installBundle(status.installSpec, {
      enabled: bundle?.enabled !== false,
      ...(status.registry ? { registry: status.registry } : {}),
    })
    if (install?.application === 'applied' || install?.application === 'restart-required') {
      this.#cache = undefined
      return {
        status: install.application,
        fromVersion: status.currentVersion,
        toVersion: status.latestVersion,
        message: install.application === 'restart-required'
          ? `已安装 v${status.latestVersion}，请完整重启 DSH（含系统托盘）使其生效。`
          : `已更新至 v${status.latestVersion}（建议刷新页面或重启 DSH 以加载最新界面）。`,
      }
    }
    if (previousSource) {
      await manager.installBundle(previousSource, { enabled: bundle?.enabled !== false }).catch(() => {})
    }
    throw new Error(install?.error?.diagnostic ?? install?.error?.code ?? '安装新版本失败，已尝试恢复旧版本')
  }
}
