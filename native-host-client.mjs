import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostDescriptorPath } from './backend-paths.mjs'

export class HostConnectionError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'HostConnectionError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/** One owned LF-delimited Host connection. A lost write is never replayed. */
export class NativeHostPeer {
  #child
  #pending = new Map()
  #listeners = new Set()
  #sequence = 0
  #prefix = `dsh:${randomUUID()}:`

  #stopped = false
  #maxFrameBytes
  #readyResolve
  #readyReject
  #readyTimer
  #closedResolve
  ready
  closed

  constructor(child, { readyTimeoutMs = 10_000, maxFrameBytes = 32 * 1024 * 1024 } = {}) {
    this.#child = child
    this.#maxFrameBytes = maxFrameBytes
    this.closed = new Promise(resolve => { this.#closedResolve = resolve })
    this.ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve
      this.#readyReject = reject
    })
    // Consumers may subscribe before awaiting readiness.
    void this.ready.catch(() => undefined)
    this.#readyTimer = setTimeout(() => this.close(new HostConnectionError('HOST_START_TIMEOUT', 'DSH Host bridge did not become ready')), readyTimeoutMs)
    child.stdout.on('data', chunk => this.#read(Buffer.from(chunk)))
    child.stdout.on('end', () => this.close())
    child.stdout.on('error', () => this.close())
    // Never expose helper stderr: upstream errors can include request secrets.
    child.stderr?.resume()
    child.stdin.on('error', () => this.close())
    child.on('error', () => this.close(new HostConnectionError('HOST_START_FAILED', 'Could not start the DSH Host bridge helper')))
    child.on('exit', () => this.close())
  }

  async request(method, params = {}, { signal, timeoutMs = 120_000 } = {}) {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    if (this.#stopped) throw disconnected()
    const id = `${this.#prefix}${++this.#sequence}`
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        const entry = this.#pending.get(id)
        if (entry === undefined) return
        this.#pending.delete(id)
        clearTimeout(entry.timer)
        signal?.removeEventListener('abort', entry.abort)
        if (error) reject(error)
        else resolve(result)
      }
      const abort = () => finish(new HostConnectionError('HOST_REQUEST_ABORTED', 'Stopped waiting for DSH Host; the request may already have run. Check its state before retrying.'))
      const timer = setTimeout(() => finish(new HostConnectionError('HOST_REQUEST_TIMEOUT', 'DSH Host did not answer in time; the request may already have run. Check its state before retrying.')), timeoutMs)
      this.#pending.set(id, { finish, timer, abort })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.#write({ id, method, params }, error => { if (error) this.close() })
      } catch (error) {
        finish(error)
      }
    })
  }

  /** Notifications and server requests retain their IDs and complete payloads. */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  notify(method, params = {}) {
    if (this.#stopped) throw disconnected()
    return new Promise((resolve, reject) => {
      this.#write({ method, params }, error => error ? reject(disconnected()) : resolve())
    })
  }

  /** The UI owner supplies a decision; the transport never approves requests. */
  respond(id, result) {
    if (this.#stopped) throw disconnected()
    if (typeof id !== 'string' && typeof id !== 'number') throw new TypeError('Host request id is required')
    return new Promise((resolve, reject) => {
      this.#write({ id, result }, error => error ? reject(disconnected()) : resolve())
    })
  }

  close(error = disconnected()) {
    if (this.#stopped) return
    this.#stopped = true
    clearTimeout(this.#readyTimer)
    this.#readyReject(error)
    this.#closedResolve(error)
    for (const entry of [...this.#pending.values()]) entry.finish(error)
    this.#listeners.clear()
    this.#chunks = []; this.#pendingBytes = 0
    // This kills only our helper, never the user's Host or its Agents.
    this.#child.kill()
  }

  #write(message, callback) {
    const frame = Buffer.from(`${JSON.stringify(message)}\n`)
    if (frame.length > this.#maxFrameBytes) throw new HostConnectionError('HOST_FRAME_TOO_LARGE', 'DSH Host request exceeds the frame size limit')
    this.#child.stdin.write(frame, callback)
  }

  // Partial frame kept as a chunk list. Re-concatenating the whole partial frame on
  // every 64 KiB pipe chunk copied ~662 MB to receive one 9.5 MB history frame and
  // crashed the DSH host with ERR_MEMORY_ALLOCATION_FAILED (2026-11-21 22:49 / 03:23).
  #chunks = []
  #pendingBytes = 0

  #read(chunk) {
    if (this.#stopped) return
    let start = 0, newline
    // Only the new chunk can contain the terminator of the pending frame.
    while ((newline = chunk.indexOf(10, start)) !== -1) {
      if (this.#pendingBytes + newline - start > this.#maxFrameBytes) { this.close(new HostConnectionError('HOST_FRAME_TOO_LARGE', 'DSH Host response exceeds the frame size limit')); return }
      const tail = chunk.subarray(start, newline)
      const frame = this.#chunks.length === 0 ? tail : Buffer.concat([...this.#chunks, tail], this.#pendingBytes + tail.length)
      this.#chunks = []; this.#pendingBytes = 0
      start = newline + 1
      if (!this.#dispatch(frame)) return
    }
    if (start < chunk.length) {
      this.#chunks.push(start === 0 ? chunk : chunk.subarray(start))
      this.#pendingBytes += chunk.length - start
    }
    if (this.#pendingBytes > this.#maxFrameBytes) this.close(new HostConnectionError('HOST_FRAME_TOO_LARGE', 'DSH Host response exceeds the frame size limit'))
  }

  /** Handle one complete frame; false when the connection was closed. */
  #dispatch(frame) {
    {
      let message
      try {
        message = JSON.parse(frame.toString('utf8'))
        if (message === null || typeof message !== 'object' || Array.isArray(message)) throw new Error()
      } catch { this.close(new HostConnectionError('HOST_INVALID_FRAME', 'DSH Host returned an invalid protocol frame')); return false }
      if (message.method === 'codexhost/remote-control-bridge/ready') {
        if (message.params?.protocolVersion !== 1) { this.close(new HostConnectionError('HOST_PROTOCOL_UNSUPPORTED', 'DSH Host bridge protocol is unsupported')); return false }
        clearTimeout(this.#readyTimer)
        this.#readyResolve()
      } else if (typeof message.method === 'string') {
        for (const listener of this.#listeners) {
          // One view failing must not drop another view's approval or stream.
          try { listener(message) } catch {}
        }
      } else {
        const entry = this.#pending.get(message.id)
        if (entry === undefined) return !this.#stopped
        if (message.error) entry.finish(new HostConnectionError(message.error.code, message.error.message, message.error.data))
        else if (Object.hasOwn(message, 'result')) entry.finish(undefined, message.result)
        else entry.finish(new HostConnectionError('HOST_INVALID_FRAME', 'DSH Host response contains neither result nor error'))
      }
    }
    // A listener may have closed the peer; stop parsing the rest of the chunk.
    return !this.#stopped
  }
}

function disconnected() {
  return new HostConnectionError('HOST_DISCONNECTED', 'DSH Host connection closed; pending request outcomes may be unknown. Reconnect and check before retrying.')
}

/** Reuse the installed Host's own Windows bridge, including its protocol adapters. */
export async function connectNativeHost({
  descriptorPath = hostDescriptorPath(),
} = {}) {
  if (process.platform !== 'win32') throw new HostConnectionError('HOST_PLATFORM_UNSUPPORTED', 'The installed DSH Host native bridge currently requires Windows')
  let descriptor
  try { descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) } catch {
    throw new HostConnectionError('HOST_NOT_RUNNING', 'Start DSH Host before connecting DSH')
  }
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || descriptor.schemaVersion !== 1 || !Number.isSafeInteger(descriptor.ownerPid) || descriptor.ownerPid <= 0
    || typeof descriptor.pipePath !== 'string' || !descriptor.pipePath.startsWith('\\\\.\\pipe\\codexhost-remote-control-')
    || typeof descriptor.nodePath !== 'string' || !path.isAbsolute(descriptor.nodePath)
    || typeof descriptor.runtimePath !== 'string' || !path.isAbsolute(descriptor.runtimePath)) {
    throw new HostConnectionError('HOST_DESCRIPTOR_INVALID', 'DSH Host connection descriptor is invalid')
  }
  try { process.kill(descriptor.ownerPid, 0) } catch {
    throw new HostConnectionError('HOST_NOT_RUNNING', 'The DSH Host connection descriptor belongs to an exited process; start DSH Host again')
  }
  const child = spawn(descriptor.nodePath, [descriptor.runtimePath, '--codexhost-remote-control-bridge'], {
    env: { ...process.env, CODEXHOST_REMOTE_CONTROL_BRIDGE_PIPE: descriptor.pipePath },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const peer = new NativeHostPeer(child)
  try {
    await peer.ready
    await peer.request('initialize', {
      clientInfo: { name: 'dsh-host', title: 'DSH Host', version: '0.4.6' },
      capabilities: { experimentalApi: true },
    }, { timeoutMs: 15_000 })
    await peer.notify('initialized')
    return peer
  } catch (error) { peer.close(); throw error }
}
