/**
 * Defer spawning the official `codex.exe app-server` (and its MCP/CUA children)
 * until a Codex-owned RPC or account refresh is actually requested.
 *
 * Works on both the reviewed unbundled 0.17.4 runtime and the esbuild-bundled
 * `backend/host-runtime.mjs`.
 */
export function patchCodexLazyStart(source, replace) {
  // 1. prepareLocalCodex: do not eagerly spawn codex.exe when host-runtime boots.
  const eagerPrepare = [
    '  try {\n    await scope.start();\n  } catch (error51) {\n    throw await scope.close(), identityReader.close(), error51;\n  }',
    '  try {\n    await scope.start();\n  } catch (error51) {\n    await scope.close();\n    identityReader.close();\n    throw error51;\n  }',
    '  try {\n    await scope.start();\n  } catch (error) {\n    await scope.close();\n    identityReader.close();\n    throw error;\n  }',
  ].find(candidate => source.includes(candidate)) ?? '  try {\n    await scope.start();\n  } catch (error) {\n    await scope.close();\n    identityReader.close();\n    throw error;\n  }'
  source = replace(
    source,
    eagerPrepare,
    '  /* lazy-start official Codex app-server on first Codex request */',
    'defer official Codex spawn out of prepareLocalCodex',
  )

  // 2. prepareLocalCodex account refresh: start official Codex on demand before account/read.
  const accountRefresh = [
    {
      old: '  }), accounts = new SingleNativeCodexAccount(snapshot2, async () => {\n    let response = await scope.owner.controlRequest("account/read", { refreshToken: !1 });',
      next: '  }), accounts = new SingleNativeCodexAccount(snapshot2, async () => {\n    if (scope.gate.phase !== "ready") await scope.start();\n    let response = await scope.owner.controlRequest("account/read", { refreshToken: !1 });',
    },
    {
      old: '  const accounts = new SingleNativeCodexAccount(snapshot2, async () => {\n    const response = await scope.owner.controlRequest("account/read", { refreshToken: false });',
      next: '  const accounts = new SingleNativeCodexAccount(snapshot2, async () => {\n    if (scope.gate.phase !== "ready") await scope.start();\n    const response = await scope.owner.controlRequest("account/read", { refreshToken: false });',
    },
    {
      old: '  const accounts = new SingleNativeCodexAccount(snapshot, async () => {\n    const response = await scope.owner.controlRequest("account/read", { refreshToken: false });',
      next: '  const accounts = new SingleNativeCodexAccount(snapshot, async () => {\n    if (scope.gate.phase !== "ready") await scope.start();\n    const response = await scope.owner.controlRequest("account/read", { refreshToken: false });',
    },
  ].find(candidate => source.includes(candidate.old)) ?? {
    old: '  const accounts = new SingleNativeCodexAccount(snapshot, async () => {\n    const response = await scope.owner.controlRequest("account/read", { refreshToken: false });',
    next: '  const accounts = new SingleNativeCodexAccount(snapshot, async () => {\n    if (scope.gate.phase !== "ready") await scope.start();\n    const response = await scope.owner.controlRequest("account/read", { refreshToken: false });',
  }
  source = replace(source, accountRefresh.old, accountRefresh.next, 'lazy-start official Codex before account/read refresh')

  // 3. AppServerHost.run(): skip eager officialRuntime.initialize() unless explicitly opted in.
  const eagerRun = [
    {
      old: '      this.#options.externalOnly || await this.#officialRuntime.initialize();',
      next: '      !this.#options.externalOnly && this.#options.eagerOfficial && await this.#officialRuntime.initialize();',
    },
    {
      old: '      if (!this.#options.externalOnly) await this.#officialRuntime.initialize();',
      next: '      if (!this.#options.externalOnly && this.#options.eagerOfficial) await this.#officialRuntime.initialize();',
    },
    {
      old: '      if (!this.#options.externalOnly) {\n        await this.#officialRuntime.initialize();\n      }',
      next: '      if (!this.#options.externalOnly && this.#options.eagerOfficial) {\n        await this.#officialRuntime.initialize();\n      }',
    },
  ].find(candidate => source.includes(candidate.old)) ?? {
    old: '      if (!this.#options.externalOnly) {\n        await this.#officialRuntime.initialize();\n      }',
    next: '      if (!this.#options.externalOnly && this.#options.eagerOfficial) {\n        await this.#officialRuntime.initialize();\n      }',
  }
  source = replace(source, eagerRun.old, eagerRun.next, 'skip eager official app-server startup in AppServerHost.run')

  // 4. OfficialRuntimeClient: start official Codex on demand before request/send/sendFrame.
  const bundledClient = `  request(method, params) {
    return this.#session.request(method, params);
  }
  send(value2) {
    return this.#closed ? Promise.reject(new Error("Official Codex is unavailable")) : this.#session.send(value2);
  }
  async sendFrame(frame) {
    if (this.#closed) throw new Error("Official Codex is unavailable");
    let value2 = parseJsonFrame(frame);
    if (typeof value2 != "object" || value2 === null || Array.isArray(value2))
      throw new Error("Official protocol frame must be an object");
    await this.#session.send(value2);
  }`
  const upstreamClient = `  request(method, params) {
    return this.#session.request(method, params);
  }
  send(value2) {
    if (this.#closed) return Promise.reject(new Error("Official Codex is unavailable"));
    return this.#session.send(value2);
  }
  async sendFrame(frame) {
    if (this.#closed) throw new Error("Official Codex is unavailable");
    const value2 = parseJsonFrame(frame);
    if (typeof value2 !== "object" || value2 === null || Array.isArray(value2))
      throw new Error("Official protocol frame must be an object");
    await this.#session.send(value2);
  }`
  const rawClient = `  request(method, params) {
    return this.#session.request(method, params);
  }
  send(value) {
    if (this.#closed) {
      return Promise.reject(new Error("Official Codex is unavailable"));
    }
    return this.#session.send(value);
  }
  async sendFrame(frame) {
    if (this.#closed) {
      throw new Error("Official Codex is unavailable");
    }
    const value = parseJsonFrame(frame);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Official protocol frame must be an object");
    }
    await this.#session.send(value);
  }`
  const lazyClient = `  async #ensureStarted() {
    if (this.#closed || this.#scope.closed) throw new OfficialAdmissionError("unavailable");
    if (this.#scope.gate.phase !== "ready") await this.#scope.start();
  }
  async request(method, params) {
    await this.#ensureStarted();
    return this.#session.request(method, params);
  }
  async send(value2) {
    if (this.#closed) throw new Error("Official Codex is unavailable");
    await this.#ensureStarted();
    return this.#session.send(value2);
  }
  async sendFrame(frame) {
    if (this.#closed) throw new Error("Official Codex is unavailable");
    let value2 = parseJsonFrame(frame);
    if (typeof value2 != "object" || value2 === null || Array.isArray(value2))
      throw new Error("Official protocol frame must be an object");
    await this.#ensureStarted();
    await this.#session.send(value2);
  }`
  source = replace(
    source,
    [bundledClient, upstreamClient, rawClient].find(candidate => source.includes(candidate)) ?? rawClient,
    lazyClient,
    'lazy-start official Codex inside OfficialRuntimeClient request/send/sendFrame',
  )

  // 5. #forwardOfficialNonRequest: ignore stray notifications while Codex is not running.
  const nonReq = source.includes('  async #forwardOfficialNonRequest(value2, frame) {\n    if (this.#options.externalOnly) return;')
    ? {
        old: '  async #forwardOfficialNonRequest(value2, frame) {\n    if (this.#options.externalOnly) return;',
        next: '  async #forwardOfficialNonRequest(value2, frame) {\n    if (this.#options.externalOnly || this.#officialRuntimeScope.gate.phase !== "ready") return;',
      }
    : {
        old: '  async #forwardOfficialNonRequest(value, frame) {\n    if (this.#options.externalOnly) {\n      return;\n    }',
        next: '  async #forwardOfficialNonRequest(value, frame) {\n    if (this.#options.externalOnly || this.#officialRuntimeScope.gate.phase !== "ready") {\n      return;\n    }',
      }
  source = replace(source, nonReq.old, nonReq.next, 'skip forwarding non-request frames before official Codex starts')

  // 6. codexhost/account/list: return snapshot without waking codex.exe when it has not started yet.
  const acctList = source.includes('          result: jsonValueSchema.parse(await this.#codexAccountSnapshot())')
    ? {
        old: '          result: jsonValueSchema.parse(await this.#codexAccountSnapshot())',
        next: '          result: jsonValueSchema.parse(request.method === "codexhost/account/list" && this.#officialRuntimeScope.gate.phase !== "ready" ? this.#accountControl.snapshot() : await this.#codexAccountSnapshot())',
      }
    : null
  if (acctList) {
    source = replace(source, acctList.old, acctList.next, 'keep codexhost/account/list passive before official Codex starts')
  }

  return source
}
