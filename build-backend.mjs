import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { patchClaudeInput } from './patch-claude-input.mjs'
import { patchClaudeNetworkRetry } from './patch-claude-network-retry.mjs'
import { patchClaudeCommands } from './patch-claude-commands.mjs'
import { patchAntigravityPerf } from './patch-antigravity-perf.mjs'
import { patchAntigravityCollaboration } from './patch-antigravity-collaboration.mjs'

// Rebuild only from the reviewed local 0.17.4 runtime, including its usage/tool fixes.
const PIN = '020fb3892483ee2e2965b37179ca2708e534ae0ba7a1bb9dbf203517641c23dc'
const root = path.dirname(fileURLToPath(import.meta.url))
const source = process.argv[2]
if (!source) throw new Error('Provide the reviewed CodexHost app directory (e.g. via scripts/setup-backend.mjs)')
const { build } = process.env.DSH_HOST_ESBUILD_PATH ? await import(pathToFileURL(process.env.DSH_HOST_ESBUILD_PATH).href) : await import('esbuild')
const digest = value => createHash('sha256').update(value).digest('hex')
const raw = await readFile(path.join(source, 'host-runtime.mjs'), 'utf8')
if (digest(raw) !== PIN) throw new Error('Unreviewed Host runtime: audit the source and patches before rebuilding')
const out = path.join(root, 'backend')
const changes = []
function replace(text, old, replacement, label) {
  if (text.split(old).length !== 2) throw new Error(`Backend patch drift: ${label}`)
  changes.push(label)
  return text.replace(old, replacement)
}
let runtime = raw
runtime = replace(runtime, 'function officialEnvironment(source) {', 'function officialEnvironment(source) {\n  source = Object.fromEntries(Object.entries(source).filter(([key]) => !["DSH_COLLABORATION_URL", "DSH_COLLABORATION_TOKEN", "DSH_WEB_BRIDGE_URL", "DSH_WEB_BRIDGE_TOKEN"].includes(key)));', 'never expose private DSH bridge credentials to the official Codex process')
const tokenUsage = (await readFile(path.join(root, 'live-token-usage.mjs'), 'utf8')).replace(/^export /gm, '')
runtime = replace(runtime, 'function projectCodexThreadUsage(input) {', tokenUsage + '\nfunction projectCodexThreadUsage(input) {', 'exact terminal token notification without context or price dependencies')
runtime = replace(runtime, '  /** The Thread\'s published usage: native fields plus Host-derived metrics. */', `  /** Synchronous, complete and deduplicated ledger; never use partial native counters. */
  dshTokenUsage() {
    return this.#metered && this.#historyComplete && !this.#invalidRecord ? hostUsageTotals(this.#requests.values()) : undefined;
  }
  /** The Thread's published usage: native fields plus Host-derived metrics. */`, 'read exact token ledger without waiting for price lookup')
runtime = replace(runtime, '    const result = projection.projector.project(event);', `    // Publish exact counters before the terminal frame closes DSH's per-turn subscriber.
    // No context refresh, price lookup, transcript scan, or separate model call here.
    if (event.type === "turn.completed" && !ephemeralTurn) {
      const notification = dshHostTokenUsageNotification(thread.id, event.turnId, thread.usageMeter.dshTokenUsage());
      if (notification) await this.#writer.json(notification);
    }
    let result = projection.projector.project(event);`, 'publish complete ledger counters before external Turn completion')
const keepaliveRpc = await readFile(path.join(root, 'keepalive-rpc-backend.txt'), 'utf8')
const titleRpc = await readFile(path.join(root, 'title-rpc-backend.txt'), 'utf8')
runtime = replace(runtime, '  async #handleDesktopRequest(request, frame) {', '  #dshKeepalive = new Map();\n  #dshTitles = new Map();\n  async #handleDesktopRequest(request, frame) {\n' + keepaliveRpc + titleRpc, 'install guarded private keepalive and title handlers from fixed input')
runtime = replace(runtime, '  async #parentMetadata(parentThreadId) {\n    const record6 = await this.#repository.find(parentThreadId);\n    if (record6)\n      return {\n        harnessId: record6.harnessId,\n        cwd: record6.cwd,\n        title: record6.title\n      };\n    const metadata = await this.#officialThreadMetadata(parentThreadId).catch(() => ({}));\n    return { harnessId: "codex", ...metadata };\n  }', `  async #parentMetadata(parentThreadId) {\n    let record6 = await this.#repository.find(parentThreadId);\n    if (!record6) return { harnessId: "codex", ...await this.#officialThreadMetadata(parentThreadId) };\n    return { harnessId: record6.harnessId, cwd: record6.cwd, title: record6.title };\n  }`, 'read official DSH parent metadata without masking errors')
runtime = replace(runtime, '  const cliPath = environment[DELEGATION_CLI_PATH_ENV] ?? environment[UPDATE_RUNTIME_ENV.launcherExecutable] ?? packagedCli;\n  const nodePath2 = environment[DELEGATION_CLI_NODE_PATH_ENV] ?? environment[UPDATE_RUNTIME_ENV.npmNodePath] ?? (packagedCli && cliPath === packagedCli ? process.execPath : void 0);\n  return {\n    ...cliPath ? { [DELEGATION_CLI_PATH_ENV]: cliPath } : {},\n    ...nodePath2 && path39.isAbsolute(nodePath2) ? { [DELEGATION_CLI_NODE_PATH_ENV]: nodePath2 } : {}\n  };', `  let cliPath = environment[DELEGATION_CLI_PATH_ENV] ?? environment[UPDATE_RUNTIME_ENV.launcherExecutable] ?? packagedCli, nodePath2 = environment[DELEGATION_CLI_NODE_PATH_ENV] ?? environment[UPDATE_RUNTIME_ENV.npmNodePath] ?? (packagedCli && cliPath === packagedCli ? process.execPath : void 0);\n  if (environment[DELEGATION_CLI_NODE_PATH_ENV] && path39.isAbsolute(environment[DELEGATION_CLI_NODE_PATH_ENV])) {\n    return {\n      ...cliPath ? { [DELEGATION_CLI_PATH_ENV]: cliPath } : {},\n      [DELEGATION_CLI_NODE_PATH_ENV]: environment[DELEGATION_CLI_NODE_PATH_ENV],\n      [UPDATE_RUNTIME_ENV.npmCliPath]: environment[UPDATE_RUNTIME_ENV.npmCliPath] ?? environment[DELEGATION_CLI_NODE_PATH_ENV].replace(/[\\\\/]+node(?:\\.exe)?$/i, '/node_modules/npm/bin/npm-cli.js')\n    };\n  }\n  return {\n    ...cliPath ? { [DELEGATION_CLI_PATH_ENV]: cliPath } : {},\n    ...nodePath2 && path39.isAbsolute(nodePath2) ? { [DELEGATION_CLI_NODE_PATH_ENV]: nodePath2 } : {}\n  };`, 'use the CodexHost-owned Node and npm for delegated CLI startup')
runtime = replace(runtime, 'queueThreadId = request.method === "codexhost/thread/usage/inspect" ? void 0 : threadId2;', 'queueThreadId = ["codexhost/thread/usage/inspect", "dsh/claude/keepalive/cancel", "dsh/claude/title/generate", "dsh/claude/title/cancel", "dsh/host/task/stop"].includes(request.method) ? void 0 : threadId2;', 'cancel keepalive without waiting for its queue')
runtime = replace(runtime, '    const matches = await this.#matching((registration) => registration.canHandleStart(input));', `    const matches = await this.#matching((registration) => registration.canHandleStart(input));
    if (input.parentThreadId && !matches.length) {
      const shared = [...this.#registrations].filter((registration) => registration.harnessCatalog && registration.canHandleStart(input));
      if (shared.length === 1) return shared[0];
    }`, 'retain the existing unique shared catalog delegation fallback')
const preheatRpc = await readFile(path.join(root, 'preheat-rpc-backend.txt'), 'utf8')
runtime = replace(runtime, '  #dshKeepalive = new Map();', '  #dshPreheats = new Map();\n  #dshKeepalive = new Map();', 'track independent account preheat operations')
runtime = replace(runtime, '  async #handleDesktopRequest(request, frame) {', '  async #handleDesktopRequest(request, frame) {\n' + preheatRpc, 'private independent Claude preheat RPC')
if (runtime.split('await this.#desktopRequests.drain()').length !== 3) throw new Error('Backend patch drift: preheat drain boundaries')
runtime = runtime.replaceAll('await this.#desktopRequests.drain()', 'await this.#dshAbortPreheats()')
runtime = replace(runtime, '  #dshPreheats = new Map();', `  #dshPreheats = new Map();
  async #dshAbortPreheats() {
    for (const controller of this.#dshKeepalive.values()) controller.abort();
    for (const controller of this.#dshTitles.values()) controller.abort();
    for (const controller of this.#dshPreheats.values()) controller.abort();
    await this.#desktopRequests.drain();
  }`, 'abort detached preheats before existing request drain')
// DSH native task mirroring: announce detached commands and stop one native task by identity.
const taskStopRpc = await readFile(path.join(root, 'task-stop-rpc-backend.txt'), 'utf8')
runtime = replace(runtime, '  #dshTitles = new Map();\n  async #handleDesktopRequest(request, frame) {\n', '  #dshTitles = new Map();\n  #dshNativeSubagents = new Map();\n  async #handleDesktopRequest(request, frame) {\n' + taskStopRpc, 'private single background task stop RPC')
runtime = replace(runtime, '    const record6 = await this.#repository.materializeSubagent(parent.record, subagent);\n    if (!record6) return subagent;', '    const record6 = await this.#repository.materializeSubagent(parent.record, subagent);\n    if (!record6) return subagent;\n    this.#dshNativeSubagents.set(parent.id + "\\u0000" + record6.hostThreadId, subagent.nativeSubagentId);', 'remember native ids of materialized subagents for task stop')
runtime = replace(runtime, '        this.#detached.add(event.itemId);\n        return { messages: [] };', '        this.#detached.add(event.itemId);\n        return { messages: [{ method: "codexhost/item/detached", emittedAtMs, params: { threadId: this.#threadId, turnId: this.#turnId, itemId: event.itemId } }] };', 'announce command Items that continue as background tasks')
runtime = replace(runtime, '  async #requestOfficial(method, params) {\n    if (this.#options.externalOnly) {', '  async #requestOfficial(method, params) {\n    if (this.#options.externalOnly || this.#options.delegationOnly) {', 'initialize the headless delegation connection before official Thread reads')
runtime = replace(runtime, 'codex_approval_kind: "mcp_tool_call",', 'codex_approval_kind: "mcp_tool_call",\n          codexhostScope: { title: interaction.title, description: interaction.description, subject: interaction.subject },', 'preserve complete native approval scope for DSH review')
runtime = replace(runtime, 'isSecret: question.secret,', 'isSecret: question.secret,\n        isOptional: question.optional,', 'preserve native text question optionality')
runtime = replace(runtime, 'isOther: question.allowOther,', 'isOther: question.allowOther,\n      multiSelect: question.multiple,\n      isOptional: question.optional,', 'preserve native choice multiplicity and optionality')
runtime = replace(runtime, 'function remoteControlBridgeDescriptorPath(environment) {', `function remoteControlBridgeDescriptorPath(environment) {
  if (environment.DSH_HOST_DESCRIPTOR_PATH) {
    if (!path35.isAbsolute(environment.DSH_HOST_DESCRIPTOR_PATH)) throw new Error("DSH Host descriptor path must be absolute");
    return environment.DSH_HOST_DESCRIPTOR_PATH;
  }`, 'private descriptor')
runtime = replace(runtime, 'dataDirectory ? path24.resolve(dataDirectory) : path24.join(os7.homedir(), ".codexhost"),', 'environment.DSH_HOST_LEGACY_DATA_DIR ? path24.resolve(environment.DSH_HOST_LEGACY_DATA_DIR) : dataDirectory ? path24.resolve(dataDirectory) : path24.join(os7.homedir(), ".codexhost"),', 'retain existing locked Thread mapping store')
runtime = replace(runtime, 'this.#directory = path12.join(environment.CODEXHOST_DATA_DIR ? path12.resolve(environment.CODEXHOST_DATA_DIR) : path12.join(os2.homedir(), ".codexhost"), "harness-launch-settings");', 'this.#directory = path12.join(environment.DSH_HOST_LEGACY_DATA_DIR ?? environment.CODEXHOST_DATA_DIR ?? path12.join(os2.homedir(), ".codexhost"), "harness-launch-settings");', 'retain existing CLI path settings')
runtime = replace(runtime, 'roots: this.#options.pluginRoots,', 'roots: this.#options.pluginRoots,\n      onlyIds: new Set(["claude-code", "antigravity", "codex-usage", "deepseek-harness"]),\n      warmup: false,', 'fixed adapter allowlist and no adapter warmup')
runtime = replace(runtime, '    this.#delegationCoordinator = new HarnessDelegationCoordinator({', `    this.#externalRuntime.idleRelease.configure({ enabled: true, timeoutMinutes: Number(process.env.DSH_HOST_IDLE_MINUTES ?? 30) });
    this.#delegationCoordinator = new HarnessDelegationCoordinator({`, 'enable guarded idle Session release')
runtime = replace(runtime, '  async #handleDesktopRequest(request, frame) {', `  async #handleDesktopRequest(request, frame) {
    if (/^codexhost\\/(?:update|remote|console|desktop)\\//.test(request.method)) {
      await this.#writer.json(rpcError(request, -32601, "Not part of the DSH Host local backend"));
      return;
    }`, 'reject standalone product management')
// Private methods cannot be removed from a class while referenced by its dispatcher.
for (const name of ['handleConsoleOpen', 'handleUpdateRequest']) {
  const expression = new RegExp(`^  async #${name}\\(request\\) \\{[\\s\\S]*?(?=^  (?:async )?#|^};)`, 'm')
  if (!expression.test(runtime)) throw new Error(`Missing method ${name}`)
  runtime = runtime.replace(expression, `  async #${name}(request) {\n    await this.#writer.json(rpcError(request, -32601, "Not part of DSH Host"));\n  }\n`)
  changes.push(`remove ${name} implementation`)
}
runtime = runtime.replaceAll('Restart Codex Desktop', 'Restart DSH').replaceAll('restart Codex Desktop', 'restart DSH')
const start = runtime.indexOf('async function runHostRuntime(input) {')
const end = runtime.indexOf('// packages/host-runtime/src/remote-host-install.ts', start)
if (start < 0 || end < 0) throw new Error('Runtime entry boundaries changed')
const entry = `async function runHostRuntime(input) {
  if (process.platform !== "win32" || input.arguments.length !== 1 || input.arguments[0] !== "app-server") throw new Error("DSH Host supports only its local Windows app-server");
  const { stockCodexPath } = requiredRuntimeConfiguration(input.environment);
  const hostRuntimePath = fileURLToPath3(input.hostRuntimeUrl);
  const modelPrices = new ModelPriceCatalog({ directory: defaultModelPriceDirectory(input.environment) });
  void modelPrices.start();
  const usageStatistics = new UsageStatistics({ directory: path39.join(defaultModelPriceDirectory(input.environment), "usage-statistics"), prices: modelPrices });
  // No independent Console, updater, SSH listener, Desktop injection or eager usage scan.
  const plan = createRemoteControlAppServerPlan({ arguments: input.arguments, environment: input.environment, hostRuntimePath });
  if (!plan) throw new Error("DSH Host requires its private local bridge descriptor");
  return prepareDelegationRuntime({ environment: plan.environment, hostRuntimePath,
    createHost: async (environment, onDelegationApi, registry) => {
      const official = await prepareLocalCodex({ stockCodexPath, arguments: plan.officialArguments, environment: { ...environment, DSH_COLLABORATION_URL: undefined, DSH_COLLABORATION_TOKEN: undefined, DSH_WEB_BRIDGE_URL: undefined, DSH_WEB_BRIDGE_TOKEN: undefined }, diagnosticOutput: process.stderr });
      const mappingStore = createProductionExternalThreadStore(environment);
      let listener;
      try {
        await mappingStore.initialize();
        const common = { stockCodexPath, environment, officialRuntimeScope: official.officialRuntimeScope, accountControl: official.accountControl,
          ...installedHarnessPluginOptions(environment, false, input.hostRuntimeUrl), mappingStore, closeMappingStoreOnExit: false, modelPrices, usageStatistics };
        const host = new AppServerHost({ ...common, delegationOnly: true, arguments: input.arguments, onDelegationApi: api => registry.register(api, { harnessCatalog: true }) });
        listener = createRemoteAppServerWebSocketListener({ socketPath: plan.pipePath, diagnosticOutput: process.stderr,
          createSession: ({ input: desktopInput, output: desktopOutput, diagnosticOutput }) => new AppServerHost({ ...common, arguments: [], desktopInput, desktopOutput, diagnosticOutput, onDelegationApi: api => registry.register(api) }) });
        await listener.listen();
        await publishRemoteControlAppServerDescriptor(plan);
        return await host.run();
      } finally {
        try { await listener?.close(); } finally { try { await official.close(); } finally { await mappingStore.close(); } }
      }
    }
  });
}

`
runtime = runtime.slice(0, start) + entry + runtime.slice(end)
const tail = runtime.indexOf('process.exitCode = arguments_[0] === "--codexhost-delegation-cli"')
if (tail < 0) throw new Error('Release entry changed')
runtime = runtime.slice(0, tail) + `process.title = "DSH Host";
process.exitCode = arguments_[0] === "--codexhost-delegation-cli" ? await runDelegationCli({ arguments: arguments_.slice(1), environment: process.env }) : arguments_[0] === "--codexhost-remote-control-bridge" ? await runRemoteControlAppServerBridge() : await runLoggedHostRuntime();\n`
async function bundle(text, filename, { fullMinify = false } = {}) {
  const result = await build({
    stdin: { contents: text, sourcefile: filename, resolveDir: source },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', treeShaking: true,
    ...(fullMinify ? { minify: true } : { minifySyntax: true }),
    legalComments: 'none', write: false,
  })
  const output = result.outputFiles[0].contents
  await mkdir(path.dirname(path.join(out, filename)), { recursive: true })
  await writeFile(path.join(out, filename), output)
  return { bytes: output.length, sha256: digest(output) }
}
await mkdir(out, { recursive: true })
const files = { 'host-runtime.mjs': await bundle(runtime, 'host-runtime.mjs') }
const adapterPins = { 'claude-code': '9c063b8ab6eb59e4ab02c671fc05e2ef646b295a8b52bd1b7b93ca5391804d2a', 'codex-usage': 'f8ceb801bb280fae8ca8a0825dae16c72e6b263ff302f8a937e17a4a5d98f1f7', antigravity: '2880b71c1813de08f5a013f4ee018c13a367ffa15a8bcfedcaf1f7f7e2ed7720', 'deepseek-harness': 'dbe1c545ac4ba99fa62571f6948f4a74b85659d1a0d0807cade640be2606d532' }
for (const id of ['claude-code', 'antigravity', 'codex-usage', 'deepseek-harness']) {
  let plugin = await readFile(path.join(source, 'plugins', id, 'plugin.mjs'), 'utf8')
  if (digest(plugin) !== adapterPins[id]) throw new Error(`Unreviewed ${id} adapter; audit before rebuilding`)
  const manifest = JSON.parse(await readFile(path.join(source, 'plugins', id, 'manifest.json'), 'utf8'))
  if (id === 'antigravity') {
    const backgroundSdk = (await readFile(path.join(root, 'native-background-bridge.mjs'), 'utf8')).replace(/^export /gm, '')
    const agyCollab = (await readFile(path.join(root, 'antigravity-collaboration.mjs'), 'utf8')).replace(/^import .*native-background-bridge\.mjs['"];?\r?\n/gm, '').replace(/^export /gm, '')
    const agyPerf = (await readFile(path.join(root, 'antigravity-perf.mjs'), 'utf8')).replace(/^export /gm, '')
    plugin = backgroundSdk + '\n' + agyCollab + '\n' + agyPerf + '\n' + plugin
    plugin = patchAntigravityPerf(plugin, replace)
    plugin = patchAntigravityCollaboration(plugin, replace)
  }
  if (id === 'claude-code') {
    const webSdk = await readFile(path.join(root, 'claude-native-web.txt'), 'utf8')
    const collaborationSdk = await readFile(path.join(root, 'claude-collaboration-sdk.txt'), 'utf8')
    const titleSdk = await readFile(path.join(root, 'claude-title-sdk.txt'), 'utf8')
    const inputGuard = await readFile(path.join(root, 'claude-input-guard.txt'), 'utf8')
    const preheatSdk = await readFile(path.join(root, 'claude-preheat-sdk.txt'), 'utf8')
    const wakePolicy = await readFile(path.join(root, 'claude-wake-policy.txt'), 'utf8')
    const networkRetry = await readFile(path.join(root, 'claude-network-retry.txt'), 'utf8') + '\n' + (await readFile(path.join(root, 'claude-503-relay.mjs'), 'utf8')).replace(/^export /gm, '')
    const backgroundSdk = (await readFile(path.join(root, 'native-background-bridge.mjs'), 'utf8')).replace(/^export /gm, '')
    const claudeCache = (await readFile(path.join(root, 'claude-catalog-cache.mjs'), 'utf8')).replace(/^export /gm, '')
    plugin = wakePolicy + '\n' + networkRetry + '\n' + backgroundSdk + '\n' + claudeCache + '\n' + preheatSdk + '\n' + inputGuard + '\n' + titleSdk + '\n' + collaborationSdk + '\n' + webSdk + '\n' + plugin
    plugin = replace(plugin, '  #accountCreditsSupported = false;', '  #accountCreditsSupported = false;\n  #dshBgRefreshStarted = false;\n  #dshBgRefresh = null;', 'track background Claude catalog SWR refresh')
    plugin = replace(plugin, `  async inspect(input = {}) {
    if (this.#closePromise) {
      return {
        status: "unavailable",
        error: invalidState("Claude Code Adapter is closing")
      };
    }
    const cwd = path15.resolve(input.cwd ?? process.cwd());
    if (!input.refresh) {
      const cached2 = this.#inspectionCache.get(cwd);
      if (cached2)
        return cached2;
    }
    const current = this.#inspectionInFlight.get(cwd);
    if (current)
      return current;
    const inspection = this.#inspectModels(cwd).then((result) => {
      if (result.status === "ready")
        this.#inspectionCache.set(cwd, result);
      return result;
    });
    this.#inspectionInFlight.set(cwd, inspection);
    void inspection.finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) {
        this.#inspectionInFlight.delete(cwd);
      }
    });
    return inspection;
  }`, `  async inspect(input = {}) {
    if (this.#closePromise) {
      return {
        status: "unavailable",
        error: invalidState("Claude Code Adapter is closing")
      };
    }
    const cwd = path15.resolve(input.cwd ?? process.cwd());
    let executable = null;
    try {
      this.#dependencies.inspectInstallation();
      executable = resolveClaudeCodeExecutable({ environment: this.#environment })?.executable ?? null;
    } catch {
      this.#inspectionCache.clear();
      return this.#inspectModels(cwd);
    }
    const cacheKey = "*";
    if (!input.refresh) {
      const cached2 = this.#inspectionCache.get(cacheKey);
      if (cached2)
        return cached2;
      const disk = dshReadClaudeCatalogCache(this.#environment, executable, harnessInspectionSchema);
      if (disk) {
        this.#inspectionCache.set(cacheKey, disk.result);
        this.#dshStartBackgroundRefresh(cwd, executable);
        return disk.result;
      }
    }
    const current = this.#inspectionInFlight.get(cacheKey);
    if (current)
      return current;
    const inspection = this.#inspectModels(cwd).then(async (result) => {
      if (!this.#closePromise && result.status === "ready") {
        this.#inspectionCache.set(cacheKey, result);
        await dshWriteClaudeCatalogCache(this.#environment, executable, result);
      }
      return result;
    });
    this.#inspectionInFlight.set(cacheKey, inspection);
    void inspection.finally(() => {
      if (this.#inspectionInFlight.get(cacheKey) === inspection) {
        this.#inspectionInFlight.delete(cacheKey);
      }
    });
    return inspection;
  }
  #dshStartBackgroundRefresh(cwd, executable) {
    if (this.#closePromise || this.#dshBgRefreshStarted)
      return;
    this.#dshBgRefreshStarted = true;
    this.#dshBgRefresh = this.#inspectModels(cwd).then(async (result) => {
      if (!this.#closePromise && result.status === "ready") {
        this.#inspectionCache.set("*", result);
        await dshWriteClaudeCatalogCache(this.#environment, executable, result);
      }
    }).catch(() => void 0).finally(() => {
      this.#dshBgRefresh = null;
    });
  }`, 'global disk SWR catalog cache for Claude Code adapter')
    plugin = patchClaudeInput(plugin, replace)
    plugin = replace(plugin, '        canUseTool: (toolName, input, options) => this.#canUseTool(toolName, input, options),', '        mcpServers: dshCollaborationMcp(this.#environment),\n        ...dshUnifiedWakeOptions(this.#environment),\n        canUseTool: (toolName, input, options) => dshCollaborationPermission(toolName, input, this.#environment) ?? this.#canUseTool(toolName, input, options),', 'preserve collaboration MCP without replacing native web tools')
    plugin = replace(plugin, '          ...this.#environment,\n          CLAUDE_CODE_ENTRYPOINT: SESSION_ENTRYPOINT,', '          ...dshCollaborationChildEnvironment(this.#environment),\n          ...dshNativeWebEnvironment(this.#environment),\n          ...dshUnifiedWakeEnvironment(this.#environment),\n          CLAUDE_CODE_ENTRYPOINT: SESSION_ENTRYPOINT,', 'do not expose private bridge credentials to Claude CLI or its shell tools')
    plugin = patchClaudeNetworkRetry(plugin, replace)
    plugin = patchClaudeCommands(plugin, replace)
    plugin = replace(plugin, '    return [...this.#commands.values()].flatMap(({ command, outcome }) => outcome ? [] : [command.taskId]);\n  }\n  follow(command) {', '    return [...this.#commands.values()].flatMap(({ command, outcome }) => outcome ? [] : [command.taskId]);\n  }\n  dshTaskIdForItem(itemId) {\n    for (const { command, outcome } of this.#commands.values()) if (!outcome && command.item.itemId === itemId) return command.taskId;\n    return void 0;\n  }\n  follow(command) {', 'resolve one open background command task')
    plugin = replace(plugin, '  async stopBackgroundWork() {\n    const transport = this.#transport;', `  /** Stop one native task; its task_notification settles the Item. */
  async dshStopNativeTask({ itemId, taskId }) {
    const transport = this.#transport;
    const id = itemId === void 0 ? taskId : this.#backgroundCommands.dshTaskIdForItem(itemId);
    if (!transport) return { ok: false, error: { message: "Claude session is not running" } };
    if (typeof id !== "string" || !id) return { ok: false, error: { message: "Background task is no longer active" } };
    try {
      await transport.stopBackgroundTask(id);
      return { ok: true, value: void 0 };
    } catch (error52) {
      return { ok: false, error: { message: error52 instanceof Error ? error52.message : String(error52) } };
    }
  }
  async stopBackgroundWork() {
    const transport = this.#transport;`, 'stop one Claude background task by Item or native id')
    const keepalive = await readFile(path.join(root, 'claude-keepalive-backend.txt'), 'utf8')
    const titleSession = await readFile(path.join(root, 'claude-title-session.txt'), 'utf8')
    plugin = replace(plugin, 'var ClaudeHarnessSession = class {', 'var ClaudeHarnessSession = class {\n  #dshEnvironment;\n' + titleSession + keepalive, 'Claude detached title and keepalive executors')
    plugin = replace(plugin, '    const environment = input.environment ? { ...this.#environment, ...input.environment } : void 0;', '    const environment = { ...this.#environment, ...input.environment };', 'preserve adapter environment for detached keepalive')
    plugin = replace(plugin, '    const environment = options.environment;', '    const environment = options.environment;\n    this.#dshEnvironment = environment ?? process.env;', 'retain native session launch environment')
    plugin = replace(plugin, '          CLAUDE_CODE_ENTRYPOINT: SESSION_ENTRYPOINT,', '          ENABLE_PROMPT_CACHING_1H: "1",\n          CLAUDE_CODE_ENTRYPOINT: SESSION_ENTRYPOINT,', 'use 1h cache for native Claude session and keepalive')
    const effortPolicy = (await readFile(path.join(root, 'claude-efforts.mjs'), 'utf8')).replace(/^export /gm, '')
    plugin = replace(plugin, 'function normalizeClaudeModelCatalog(snapshot) {', effortPolicy + '\nfunction normalizeClaudeModelCatalog(snapshot) {', 'per-model Claude effort policy')
    plugin = replace(plugin, '  resolvedModel: harnessResolvedModelLabelSchema.optional()\n', '  resolvedModel: harnessResolvedModelLabelSchema.optional(),\n  supportsEffort: external_exports.boolean().optional(),\n  supportedEffortLevels: external_exports.array(external_exports.string()).optional(),\n  supportsThinkingOff: external_exports.boolean().optional()\n', 'preserve Claude CLI effort capability fields')
    plugin = replace(plugin, 'supportedThinkingOptionIds: [...CLAUDE_THINKING_OPTION_IDS]', 'supportedThinkingOptionIds: dshClaudeThinkingOptionIds(row)', 'do not advertise unverified Claude effort levels')
    plugin = replace(plugin, '          CLAUDE_CODE_ENTRYPOINT: SESSION_ENTRYPOINT,', '          CLAUDE_CODE_ENTRYPOINT: SESSION_ENTRYPOINT,\n          CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",', 'disable Claude CLI automatic titles without changing client identity')
    plugin = replace(plugin, '    return $n("sdk_session_title_generate", async () => (await this.request({ subtype: "generate_session_title", description: e, persist: t?.persist })).response.title);', '    // Main transport never generates titles; DSH uses an isolated title-only child.\n    return null;', 'disable explicit SDK title requests')
  }
  if (id === 'deepseek-harness') {
    const cut = plugin.indexOf('// dist/harness-commands.js')
    if (cut < 0) throw new Error('DSH usage reader boundary changed')
    // Usage only: no executable probe, inspect/open factory or Web process launcher exists.
    plugin = plugin.slice(0, cut) + `\nexport function createUsageStatisticsAdapter(context) { return { harnessId: "deepseek-harness", usageStatistics: createDshUsageStatistics(context.environment), close: async () => {} }; }\n`
    manifest.kind = 'usage'; delete manifest.launchCommand; delete manifest.installation; delete manifest.notice
  }
  files[`plugins/${id}/plugin.mjs`] = await bundle(plugin, `plugins/${id}/plugin.mjs`, { fullMinify: id === 'codex-usage' || id === 'deepseek-harness' })
  if (manifest.icon) {
    const icon = path.resolve(source, 'plugins', id, manifest.icon)
    const target = path.resolve(out, 'plugins', id, manifest.icon)
    await mkdir(path.dirname(target), { recursive: true }); await cp(icon, target)
  }
  await writeFile(path.join(out, 'plugins', id, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}
await writeFile(path.join(out, 'plugins', 'enabled.json'), JSON.stringify({ version: 1, enabled: ['claude-code', 'antigravity', 'codex-usage', 'deepseek-harness'] }, null, 2) + '\n')
await cp(path.resolve(source, '../licenses'), path.join(out, 'licenses'), { recursive: true })
await cp(path.resolve(source, '../THIRD_PARTY_NOTICES.txt'), path.join(out, 'THIRD_PARTY_NOTICES.txt'))
await writeFile(path.join(out, 'build-manifest.json'), JSON.stringify({ sourceRuntimeSha256: PIN, adapterPins, builtFrom: 'local patched CodexHost 0.17.4', buildTool: 'esbuild 0.25.12', changes, dshAdapter: 'usage-only; no reverse DSH execution', files }, null, 2) + '\n')
console.log(JSON.stringify({ originalRuntimeBytes: Buffer.byteLength(raw), files }, null, 2))
