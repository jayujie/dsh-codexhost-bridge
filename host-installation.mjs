import path from 'node:path'
import { homedir } from 'node:os'
import { readFile, readdir, stat } from 'node:fs/promises'
import { HostConnectionError } from './native-host-client.mjs'
import { bundledHostRuntimePath, hostDescriptorPath } from './backend-paths.mjs'

export const defaultDescriptorPath = () => hostDescriptorPath()

export async function readHostDescriptor(descriptorPath = defaultDescriptorPath()) {
  try { return JSON.parse(await readFile(descriptorPath, 'utf8')) } catch { return undefined }
}

export function hostIsAlive(descriptor) {
  if (!Number.isSafeInteger(descriptor?.ownerPid) || descriptor.ownerPid <= 0) return false
  try { process.kill(descriptor.ownerPid, 0); return true } catch { return false }
}

/** A standalone Node Host must not pass Electron's private crash reporter pipe to Harness CLIs. */
export function standaloneHostEnvironment(environment) {
  const result = { ...environment }
  delete result.CHROME_CRASHPAD_PIPE_NAME
  return result
}

async function file(candidate) { return typeof candidate === 'string' && path.isAbsolute(candidate) && (await stat(candidate).catch(() => null))?.isFile() }
async function newestFiles(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const candidates = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const target = path.join(directory, entry.name, suffix)
    const info = await stat(target).catch(() => null)
    return info?.isFile() ? { target, time: info.mtimeMs } : undefined
  }))
  return candidates.filter(Boolean).sort((a, b) => b.time - a.time).map(entry => entry.target)
}

/** Resolve real installed files; overrides fail rather than silently selecting another installation. */
export async function resolveHostInstallation(config = {}) {
  const descriptor = await readHostDescriptor(hostDescriptorPath(config))
  const local = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
  const appdata = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
  const runtimePath = config.hostRuntimePath ?? bundledHostRuntimePath()
  const nodes = [descriptor?.nodePath,
    ...await newestFiles(path.join(local, 'CodexHostRuntime'), 'node.exe'),
    ...await newestFiles(path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Local', 'CodexHostRuntime'), 'node.exe'),
    ...((process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'node.exe'))),
  ]
  let nodePath = config.hostNodePath
  if (nodePath === undefined) for (const candidate of nodes) if (await file(candidate)) { nodePath = candidate; break }
  const stockCandidates = await newestFiles(path.join(local, 'OpenAI', 'Codex', 'bin'), 'codex.exe')
  const stockCodexPath = config.stockCodexPath ?? process.env.CODEXHOST_STOCK_CODEX_PATH ?? stockCandidates[0]
  for (const [key, value] of Object.entries({ hostNodePath: nodePath, hostRuntimePath: runtimePath })) {
    if (!await file(value)) throw new HostConnectionError('HOST_INSTALLATION_MISSING', `CodexHost installation file is unavailable: ${key}. Configure its actual path in the plugin settings.`)
  }
  const appDirectory = path.dirname(runtimePath)
  const npmCandidates = [process.env.npm_execpath, ...((process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')))]
  let npmCli
  for (const candidate of npmCandidates) if (await file(candidate)) { npmCli = candidate; break }
  return { nodePath, runtimePath, stockCodexPath, appDirectory,
    npmCli,
    npmWrapper: path.join(appdata, 'npm', 'node_modules', '@codexhost', 'cli', 'bin', 'codexhost.js'),
    consolePath: path.join(appDirectory, 'console-server.mjs'),
    launcherPath: path.resolve(appDirectory, '../bin/codexhost.exe'),
    descriptorPath: hostDescriptorPath(config),
  }
}

export async function requireStockCodex(installation) {
  if (!await file(installation.stockCodexPath)) throw new HostConnectionError('HOST_CODEX_MISSING', 'The installed Codex CLI could not be found. Configure stockCodexPath before starting the background Host.')
  return installation.stockCodexPath
}
