import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const bundledHostRuntimePath = () => fileURLToPath(new URL('./backend/host-runtime.mjs', import.meta.url))
export const hostDataDirectory = (config = {}, environment = process.env) => config.backendDataDir ?? path.join(environment.DSH_HOME ?? path.join(homedir(), '.dsh'), 'dsh-host')
export const hostDescriptorPath = (config = {}) => config.descriptorPath ?? path.join(hostDataDirectory(config), 'remote-control-bridge-v1.json')
export const legacyHostDataDirectory = (config = {}, environment = process.env) => config.legacyHostDataDir ?? environment.CODEXHOST_DATA_DIR ?? path.join(homedir(), '.codexhost')
export const dshHostRuntimeNodePath = environment => environment.DSH_HOST_NODE_PATH ?? environment.CODEXHOST_HOST_NODE_PATH
export const dshHostRuntimeNpmPath = environment => environment.DSH_HOST_NPM_PATH
  ?? environment.CODEXHOST_NPM_CLI_PATH
  ?? (dshHostRuntimeNodePath(environment) ? path.join(path.dirname(dshHostRuntimeNodePath(environment)), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined)

/** Owned backend policy; preserve engine credentials, never inherit unrelated product endpoints. */
export function backendEnvironment(installation, config, environment) {
  const result = { ...environment, ...config.claudeEnvironment, CODEXHOST_DATA_DIR: hostDataDirectory(config, environment),
    DSH_HOST_DESCRIPTOR_PATH: installation.descriptorPath,
    DSH_HOST_LEGACY_DATA_DIR: legacyHostDataDirectory(config, environment),
    DSH_HOST_IDLE_MINUTES: String(config.idleReleaseMinutes ?? 30),
    DSH_HOST_NODE_PATH: dshHostRuntimeNodePath(environment),
    DSH_HOST_NPM_PATH: dshHostRuntimeNpmPath(environment),
    // Applies to this backend and its children only, not the user's standalone CLI.
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CODEXHOST_HOST_NODE_PATH: installation.nodePath, CODEXHOST_HOST_RUNTIME_PATH: installation.runtimePath,
    CODEXHOST_STOCK_CODEX_PATH: installation.stockCodexPath,
    CODEXHOST_PLUGIN_DIRECTORY: path.join(path.dirname(installation.runtimePath), 'plugins'),
  }
  for (const key of ['DSH_WEB_BRIDGE_URL', 'DSH_WEB_BRIDGE_TOKEN', 'DSH_CLAUDE_NATIVE_SEARCH', 'CHROME_CRASHPAD_PIPE_NAME', 'CODEXHOST_LAUNCHER_EXECUTABLE', 'CODEXHOST_REMOTE_CONTROL_BRIDGE_PIPE', 'CODEXHOST_RUNTIME_ENDPOINT', 'CODEXHOST_RUNTIME_TOKEN', 'CODEXHOST_CLI_PATH', 'CODEXHOST_CLI_NODE_PATH', 'CODEXHOST_CLI_NPM_PATH', 'CODEXHOST_NPM_NODE_PATH', 'CODEXHOST_NPM_CLI_PATH', 'CODEXHOST_THREAD_ID', 'CODEXHOST_REMOTE_SSH_MANAGED', 'CODEXHOST_RUNTIME_DESCRIPTOR_PATH']) delete result[key]
  return result
}
