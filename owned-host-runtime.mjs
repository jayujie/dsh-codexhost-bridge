import { spawn } from 'node:child_process'
import { mkdir, open, stat, unlink, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HostConnectionError, connectNativeHost } from './native-host-client.mjs'
import { readHostDescriptor, hostIsAlive, resolveHostInstallation, requireStockCodex } from './host-installation.mjs'
import { backendEnvironment, hostDescriptorPath, hostDataDirectory, legacyHostDataDirectory } from './backend-paths.mjs'

/** Keeps a background Host's stdin alive; never restarts Codex Desktop or replays a Turn. */
export class OwnedHostRuntime {
  #config
  #starting
  #child
  #closed = false
  #lock
  constructor(config = {}) { this.#config = config }
  setClaudeEnvironment(environment) { this.#config = { ...this.#config, claudeEnvironment: environment } }

  async connect() {
    await this.ensure()
    return connectNativeHost({ descriptorPath: hostDescriptorPath(this.#config) })
  }

  async ensure() {
    if (this.#closed) throw new HostConnectionError('HOST_DRIVER_UNLOADED', 'DSH Host bridge has stopped')
    if (hostIsAlive(await readHostDescriptor(hostDescriptorPath(this.#config)))) return
    if (this.#config.autoStartHost === false) throw new HostConnectionError('HOST_NOT_RUNNING', 'DSH Host is not running. Start it from the console, or enable the plugin background Host.')
    this.#starting ??= this.#start().finally(() => { this.#starting = undefined })
    return this.#starting
  }

  async #start() {
    const installation = await resolveHostInstallation(this.#config)
    const stock = await requireStockCodex(installation)
    const data = hostDataDirectory(this.#config)
    await mkdir(data, { recursive: true })
    // Seed user-edited prices once; never overwrite a DSH Host edit or copy runtime credentials.
    try { await copyFile(path.join(legacyHostDataDirectory(this.#config), 'pricing.json'), path.join(data, 'pricing.json'), constants.COPYFILE_EXCL) }
    catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error }
    const lockPath = path.join(path.dirname(installation.descriptorPath), 'dsh-background-host.lock')
    await mkdir(path.dirname(lockPath), { recursive: true })
    const deadline = Date.now() + (this.#config.hostStartTimeoutMs ?? 30_000)
    while (!this.#lock) {
      if (hostIsAlive(await readHostDescriptor(installation.descriptorPath))) return
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ ownerPid: process.pid }))
        await handle.close()
        this.#lock = lockPath
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const owner = await readHostDescriptor(lockPath)
        const age = Date.now() - ((await stat(lockPath).catch(() => null))?.mtimeMs ?? Date.now())
        if ((owner !== undefined && !hostIsAlive(owner)) || (owner === undefined && age > (this.#config.hostStartTimeoutMs ?? 30_000))) { await unlink(lockPath).catch(() => {}); continue }
        if (Date.now() >= deadline) throw new HostConnectionError('HOST_START_TIMEOUT', 'Another DSH process is starting the background Host; its readiness could not be confirmed')
        await delay(100)
      }
    }
    if (this.#closed) { await this.#releaseLock(); throw new HostConnectionError('HOST_DRIVER_UNLOADED', 'DSH Host bridge has stopped') }
    const environment = backendEnvironment({ ...installation, stockCodexPath: stock }, this.#config, process.env)
    const child = spawn(installation.nodePath, [installation.runtimePath, 'app-server'], { env: environment, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
    this.#child = child
    let failure
    child.once('error', () => { failure = new HostConnectionError('HOST_START_FAILED', 'The background Host process could not be started; check the configured executable paths') })
    child.once('exit', code => { failure = new HostConnectionError('HOST_START_FAILED', `The background Host exited (${code}); inspect the DSH Host logs in the console`); if (this.#child === child) { this.#child = undefined; void this.#releaseLock() } })
    child.stdin.on('error', () => {})
    try {
      while (Date.now() < deadline) {
        if (this.#closed) throw new HostConnectionError('HOST_DRIVER_UNLOADED', 'DSH Host bridge has stopped')
        if (failure) throw failure
        const descriptor = await readHostDescriptor(installation.descriptorPath)
        if (descriptor?.ownerPid === child.pid && hostIsAlive(descriptor)) return
        await delay(30)
      }
      throw new HostConnectionError('HOST_START_TIMEOUT', 'The background Host did not publish its native connection in time')
    } catch (error) { await this.closeChild(); throw error }
  }

  async #releaseLock() {
    const lock = this.#lock
    this.#lock = undefined
    if (lock) await unlink(lock).catch(() => {})
  }

  async closeChild() {
    const child = this.#child
    if (!child || child.exitCode !== null) { await this.#releaseLock(); return }
    const ended = new Promise(resolve => child.once('exit', resolve))
    child.stdin.end()
    let timer
    await Promise.race([ended, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve() }, 5000) })])
    clearTimeout(timer)
    this.#child = undefined
    await this.#releaseLock()
  }

  async close() { this.#closed = true; await this.#starting?.catch(() => {}); await this.closeChild() }
}
