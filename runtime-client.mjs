import { bridgeError, bridgeResponse } from './protocol.mjs'
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class RuntimeClientError extends Error {
  constructor(code, message, status = 500) {
    super(message)
    this.name = 'RuntimeClientError'
    this.code = code
    this.status = status
  }
}

export class DshHostRuntimeClient {
  #endpoint
  #token
  #fetch
  #cliScript
  #cliNodePath
  #npmCliPath

  constructor({ endpoint, token, cliScript, cliNodePath, npmCliPath, fetchImpl = globalThis.fetch }) {
    this.#endpoint = typeof endpoint === 'string' ? endpoint.trim() : ''
    this.#token = typeof token === 'string' ? token : ''
    this.#fetch = fetchImpl
    this.#cliScript = typeof cliScript === 'string' && cliScript.trim() !== ''
      ? cliScript.trim()
      : defaultCliScript()
    this.#cliNodePath = typeof cliNodePath === 'string' && path.isAbsolute(cliNodePath)
      ? cliNodePath
      : undefined
    this.#npmCliPath = typeof npmCliPath === 'string' && npmCliPath.trim() !== ''
      ? npmCliPath.trim()
      : defaultNpmCliPath()
  }

  configured() {
    return (this.#endpoint !== '' && this.#token !== '') || this.#cliScript !== undefined
  }

  async status() {
    if (this.#endpoint !== '' && this.#token !== '') return { configured: true, mode: 'http' }
    if (this.#cliScript !== undefined && await fileExists(this.#cliScript)) return { configured: true, mode: 'cli' }
    return { configured: false, mode: 'unconfigured' }
  }

  async request(path, body) {
    if (!(this.#endpoint !== '' && this.#token !== '')) {
      return this.#requestCli(path, body)
    }
    if (!this.configured()) {
      throw new RuntimeClientError('runtime_not_configured', 'DSH Host Runtime endpoint and token are not configured', 503)
    }
    let url
    try {
      url = new URL(path, this.#endpoint)
    } catch {
      throw new RuntimeClientError('runtime_endpoint_invalid', 'DSH Host Runtime endpoint is invalid', 503)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new RuntimeClientError('runtime_endpoint_invalid', 'DSH Host Runtime endpoint must use HTTP or HTTPS', 503)
    }
    let response
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        redirect: 'error',
      })
    } catch (error) {
      throw new RuntimeClientError('runtime_unreachable', 'DSH Host Runtime could not be reached', 502)
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new RuntimeClientError('runtime_invalid_response', `DSH Host Runtime returned invalid JSON (HTTP ${response.status})`, 502)
    }
    if (!response.ok || payload?.error) {
      const message = typeof payload?.error?.message === 'string' ? payload.error.message : 'DSH Host Runtime request failed'
      throw new RuntimeClientError(typeof payload?.error?.code === 'string' ? payload.error.code : 'runtime_error', message, response.status)
    }
    return payload
  }

  async #requestCli(route, body = {}) {
    if (this.#cliScript === undefined || !(await fileExists(this.#cliScript))) {
      throw new RuntimeClientError('runtime_not_configured', 'DSH Host CLI script is not available', 503)
    }
    const args = cliArguments(route, body)
    const environment = {
      ...process.env,
      ...(this.#npmCliPath ? { npm_execpath: this.#npmCliPath } : {}),
    }
    if (this.#cliNodePath) {
      environment.CODEXHOST_NPM_NODE_PATH = this.#cliNodePath
      if (this.#npmCliPath) environment.CODEXHOST_NPM_CLI_PATH = this.#npmCliPath
      delete environment.CODEXHOST_RUNTIME_ENDPOINT
      delete environment.CODEXHOST_RUNTIME_TOKEN
    }
    try {
      const result = await execFileAsync(this.#cliNodePath ?? process.execPath, [this.#cliScript, ...args, '--format', 'json'], {
        env: environment,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      })
      try { return JSON.parse(result.stdout) } catch {
        throw new RuntimeClientError('runtime_invalid_response', 'DSH Host CLI returned invalid JSON', 502)
      }
    } catch (error) {
      if (error instanceof RuntimeClientError) throw error
      let payload
      try { payload = JSON.parse(error?.stderr ?? '') } catch { payload = undefined }
      const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'runtime_unreachable'
      const message = typeof payload?.error?.message === 'string' ? payload.error.message : 'DSH Host CLI request failed'
      throw new RuntimeClientError(code, message, 502)
    }
  }

  listHarnesses(request) {
    return this.request('/v1/harness/list', {}).then(result => bridgeResponse(request, result))
  }

  inspectHarness(request, harnessId) {
    return this.request('/v1/harness/inspect', { harnessId, refresh: false }).then(result => bridgeResponse(request, result))
  }

  listThreads(request, input = {}) {
    return this.request('/v1/thread/list', {
      cwd: input.cwd ?? process.cwd(),
      limit: input.limit ?? 25,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      sort: input.sort ?? 'updated-desc',
    }).then(result => bridgeResponse(request, result))
  }

  readThread(request, input) {
    return this.request('/v1/thread/read', {
      threadId: input.threadId,
      view: input.view ?? 'messages',
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    }).then(result => bridgeResponse(request, result))
  }

  sendThread(request, input) {
    return this.request('/v1/thread/send', { threadId: input.threadId, message: input.message })
      .then(result => bridgeResponse(request, result))
  }

  startDelegate(request, input) {
    return this.request('/v1/delegate/start', {
      harnessId: input.harnessId,
      task: input.task,
      cwd: input.cwd ?? process.cwd(),
      parentThreadId: input.parentThreadId,
      taskName: input.taskName,
      watch: input.watch,
    }).then(result => bridgeResponse(request, result))
  }

  async safeListHarnesses(request) {
    try { return await this.listHarnesses(request) } catch (error) {
      return bridgeError(request, error.code ?? 'runtime_error', error.message)
    }
  }

  async safeListThreads(request, input) {
    try { return await this.listThreads(request, input) } catch (error) {
      return bridgeError(request, error.code ?? 'runtime_error', error.message)
    }
  }
}

function defaultCliScript() {
  if (process.env.CODEXHOST_CLI_SCRIPT) return process.env.CODEXHOST_CLI_SCRIPT
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'npm', 'node_modules', '@codexhost', 'cli', 'bin', 'codexhost.js')
  return undefined
}

function defaultNpmCliPath() {
  if (process.env.npm_execpath) return process.env.npm_execpath
  const nodeRoot = path.resolve(path.dirname(process.execPath), '..')
  const bundled = path.join(nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(bundled)) return bundled
  const pathValue = process.env.PATH ?? ''
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(candidate)) return candidate
  }
  try {
    const npmLaunchers = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['npm.cmd'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    }).split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    for (const launcher of npmLaunchers) {
      const candidate = path.join(path.dirname(launcher), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (existsSync(candidate)) return candidate
    }
  } catch {
  }
  for (const candidate of [
    path.join(process.env.ProgramFiles ?? '', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'D:/nodejs/node_modules/npm/bin/npm-cli.js',
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return bundled
}

async function fileExists(filePath) {
  try { await access(filePath); return true } catch { return false }
}

export function cliArguments(route, body) {
  switch (route) {
    case '/v1/harness/list': return ['harness', 'list']
    case '/v1/harness/inspect': return ['harness', 'inspect', body.harnessId]
    case '/v1/thread/list': return ['thread', 'list', ...(body.cwd ? ['--cwd', body.cwd] : []), ...(body.limit ? ['--limit', String(body.limit)] : []), ...(body.cursor ? ['--cursor', body.cursor] : []), ...(body.sort ? ['--sort', body.sort] : [])]
    case '/v1/thread/read': return ['thread', 'read', body.threadId, '--view', body.view ?? 'messages', ...(body.cursor ? ['--cursor', body.cursor] : []), ...(body.limit ? ['--limit', String(body.limit)] : [])]
    case '/v1/thread/send': return ['thread', 'send', body.threadId, '--message', body.message]
    case '/v1/delegate/start': return ['delegate', 'start', '--harness', body.harnessId, '--task', body.task, '--cwd', body.cwd ?? process.cwd(), ...(body.parentThreadId ? ['--parent-thread', body.parentThreadId] : []), ...(body.taskName ? ['--task-name', body.taskName] : []), ...(body.watch === undefined ? [] : ['--watch', String(body.watch)])]
    default: throw new RuntimeClientError('unsupported_operation', `Unsupported DSH Host CLI route: ${route}`, 400)
  }
}
