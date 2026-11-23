import { installNativeSessionDriver } from './native-session-driver.mjs'
import { installNativeRemote } from './native-remote-service.mjs'
import { installConsoleRemote } from './console-host.mjs'
import { OwnedHostRuntime } from './owned-host-runtime.mjs'
import { installObservationProjection } from './native-observations.mjs'
import { installQuotaPauseProjection } from './native-quota-pause.mjs'
import { installSessionApiCost } from './session-api-cost.mjs'
import { installWorkspaceFilePaths } from './workspace-file-paths.mjs'
import { installNativeDelegation } from './native-delegation.mjs'
import { installCollaborationBridge } from './host-collaboration.mjs'
import path from 'node:path'

export const name = 'codexhost-bridge'
export const inject = ['loader', 'agents', 'agentPresets', 'agentLoop', 'sessionPersistence', 'sessionProjections', 'typert', 'workspaceRegistry', 'tools', 'subagents']

export async function apply(ctx, config = {}) {
  const observations = await installObservationProjection(ctx)
  await installQuotaPauseProjection(ctx)
  installWorkspaceFilePaths(ctx)
  const turnTimeoutMs = timeout(config.nativeTurnTimeoutMs, 600_000, 'nativeTurnTimeoutMs')
  const cancelTimeoutMs = timeout(config.nativeCancelTimeoutMs, 10_000, 'nativeCancelTimeoutMs')
  const hostStartTimeoutMs = timeout(config.hostStartTimeoutMs, 30_000, 'hostStartTimeoutMs')
  if (config.autoStartHost !== undefined && typeof config.autoStartHost !== 'boolean') throw new TypeError('autoStartHost must be a boolean')
  const idleReleaseMinutes = config.idleReleaseMinutes ?? 30
  if (!Number.isSafeInteger(idleReleaseMinutes) || idleReleaseMinutes < 5 || idleReleaseMinutes > 1440) throw new TypeError('idleReleaseMinutes must be an integer between 5 and 1440')
  for (const key of ['backendDataDir', 'legacyHostDataDir', 'descriptorPath', 'hostRuntimePath', 'hostNodePath', 'stockCodexPath']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !path.isAbsolute(config[key]))) throw new TypeError(`${key} must be an absolute path`)
  }
  await installSessionApiCost(ctx, config)
  const runtime = new OwnedHostRuntime({ ...config, hostStartTimeoutMs, idleReleaseMinutes })
  if (config.generateMissingTitles !== undefined && typeof config.generateMissingTitles !== 'boolean') throw new TypeError('generateMissingTitles must be a boolean')
  const titlePolicy = { enabled: config.generateMissingTitles !== false, timeoutMs: timeout(config.titleTimeoutMs, 30_000, 'titleTimeoutMs'),
    maxInputBytes: positive(config.titleMaxInputBytes, 16_000, 'titleMaxInputBytes'), maxOutputTokens: positive(config.titleMaxOutputTokens, 512, 'titleMaxOutputTokens') }
  if (config.nativeClaudeTitles !== undefined && typeof config.nativeClaudeTitles !== 'boolean') throw new TypeError('nativeClaudeTitles must be a boolean')
  const nativeTitleModel = config.claudeTitleModel ?? 'claude-haiku-5-5'
  if (typeof nativeTitleModel !== 'string' || !nativeTitleModel.startsWith('claude-') || nativeTitleModel.length > 256) throw new TypeError('claudeTitleModel must be a native Claude model identifier')
  const nativeTitleTokens = config.claudeTitleMaxOutputTokens ?? 512, nativeTitleTimeout = config.claudeTitleTimeoutMs ?? 30000, nativeTitleCost = config.claudeTitleMaxCostUsd ?? 0.05
  if (!Number.isSafeInteger(nativeTitleTokens) || nativeTitleTokens < 128 || nativeTitleTokens > 4096) throw new TypeError('claudeTitleMaxOutputTokens must be between 128 and 4096')
  if (!Number.isSafeInteger(nativeTitleTimeout) || nativeTitleTimeout < 1000 || nativeTitleTimeout > 60000) throw new TypeError('claudeTitleTimeoutMs must be between 1000 and 60000')
  if (!Number.isFinite(nativeTitleCost) || nativeTitleCost <= 0 || nativeTitleCost > 1) throw new TypeError('claudeTitleMaxCostUsd must be greater than 0 and at most 1')
  titlePolicy.nativeClaude = { enabled: titlePolicy.enabled && config.nativeClaudeTitles !== false, model: nativeTitleModel, maxInputBytes: Math.min(titlePolicy.maxInputBytes, 65536), maxOutputTokens: nativeTitleTokens, timeoutMs: nativeTitleTimeout, maxCostUsd: nativeTitleCost }
  if (config.nativeInteractionApprovals !== undefined && typeof config.nativeInteractionApprovals !== 'boolean') throw new TypeError('nativeInteractionApprovals must be a boolean')
  const driver = await installNativeSessionDriver(ctx, { turnTimeoutMs, cancelTimeoutMs, titlePolicy, nativeInteractionApprovals: config.nativeInteractionApprovals !== false, observationOf: session => observations.stateOf(session), connect: () => runtime.connect() })
  const collaboration = await installCollaborationBridge(ctx, driver, Object.assign({}, ...await Promise.all(['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session'].map(name => ctx.loader.import(name)))))
  driver.setCollaboration(collaboration.manager)
  runtime.setClaudeEnvironment(collaboration.environment)
  ctx.effect(() => async () => { await driver.dispose(); await runtime.close() }, 'codexhost: owned background Host')
  await installNativeDelegation(ctx, driver)
  await installNativeRemote(ctx, driver)
  await installConsoleRemote(ctx, config, driver)
}

function timeout(value, fallback, field) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1000 || resolved > 86_400_000) throw new TypeError(`${field} must be an integer between 1000 and 86400000 milliseconds`)
  return resolved
}

function positive(value, fallback, field) {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${field} must be a positive integer`)
  return resolved
}
