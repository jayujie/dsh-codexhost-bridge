export function patchClaudeNetworkRetry(source, replace) {
  source = replace(source,
    '          ...dshUnifiedWakeEnvironment(this.#environment),\n          CLAUDE_CODE_ENTRYPOINT: SESSION_ENTRYPOINT,',
    '          ...dshUnifiedWakeEnvironment(this.#environment),\n          ...dshClaudeMainRetryEnvironment(this.#environment),\n          CLAUDE_CODE_ENTRYPOINT: SESSION_ENTRYPOINT,',
    'bounded native network retry for managed main transport only');
  source = replace(source,
    '          this.#observeRootToolCalls(message);',
    `          // InputGate has accepted this input before attributing a retry to it.
          const retryDecision = dshClaudeRetryDecision(message, this.#environment);
          if (retryDecision) {
            process.stderr.write(dshClaudeRetryLog(retryDecision));
            if (!retryDecision.allow && !active.dshRetryFailure) {
              active.dshRetryFailure = retryDecision.kind;
              await this.#stopRequest(activeQuery.interrupt(), "Claude API retry stop was not confirmed");
            }
            continue;
          }
          this.#observeRootToolCalls(message);`,
    'stop HTTP/unknown retry at native backoff without resubmitting input');
  source = replace(source,
    '            active.resolve(active.dshInputGate.empty(interpreted2.terminal) ? { status: "failed", kind: "emptyResponse" } : interpreted2.terminal);',
    '            active.resolve(active.dshRetryFailure && !active.dshInputGate.cancelRequested ? { status: "failed", kind: active.dshRetryFailure } : active.dshInputGate.empty(interpreted2.terminal) ? { status: "failed", kind: "emptyResponse" } : interpreted2.terminal);',
    'policy-interrupted API retry is a failure, not user cancellation or success');
  source = replace(source, 'function transportFailure(kind) {',
    `function transportFailure(kind) {
  if (kind === "dshQuotaRetryStopped" || kind === "dshApiRetryStopped") return {
    code: "unavailable",
    message: kind === "dshQuotaRetryStopped"
      ? "Claude API returned HTTP 429; automatic retry stopped. This was not a user cancellation; wait for quota/rate-limit recovery before continuing."
      : "Claude API retry stopped: only two bounded statusless connection-error retries are allowed; HTTP and unknown errors are not automatically repeated.",
    retryable: false
  };`, 'surface local retry-policy failure instead of UNKNOWN/user stopped');
  source = replace(source, 'var ClaudeSdkTransport = class {', 'var ClaudeSdkTransport = class {\n  #dsh503Relay = null;', 'own one API retry relay per main transport');
  source = replace(source,
    '    const thinking = claudeThinkingConfiguration(this.#thinkingOptionId);\n    const activeQuery = this.#queryFactory({',
    '    const thinking = claudeThinkingConfiguration(this.#thinkingOptionId);\n    const dshRelayTarget = dshUnifiedWakeEnabled(this.#environment) && dshClaude503RelaySupported(this.#environment) ? dshClaudeEffectiveBaseUrl(this.#environment, this.#cwd) : undefined;\n    if (dshRelayTarget) this.#dsh503Relay = await dshCreateClaude503Relay(this.#environment, { baseUrl: dshRelayTarget });\n    let activeQuery;\n    try { activeQuery = this.#queryFactory({',
    'start transparent main API relay without changing provider configuration');
  source = replace(source,
    '          ...dshClaudeMainRetryEnvironment(this.#environment),',
    '          ...dshClaudeMainRetryEnvironment(this.#environment),\n          ...this.#dsh503Relay ? dshClaudeRelayEnvironment(this.#dsh503Relay, this.#environment) : {},',
    'avoid double native retries and retain sufficient first-byte budget during 503 waits');
  source = replace(source,
    '    this.#query = activeQuery;\n    try {',
    '    } catch (error) { await this.#dsh503Relay?.close(); this.#dsh503Relay = null; throw error; }\n    this.#query = activeQuery;\n    try {',
    'close retry relay if SDK query creation fails');
  source = replace(source,
    '      activeQuery.close();\n      this.#query = null;',
    '      activeQuery.close();\n      await this.#dsh503Relay?.close(); this.#dsh503Relay = null;\n      this.#query = null;',
    'close retry relay if SDK initialization fails');
  source = replace(source, '    accumulator.requestCancel();', '    accumulator.requestCancel();\n    this.#dsh503Relay?.cancel();', 'stop pending retries on user cancellation');
  source = replace(source,
    '    idle.requestCancel();',
    '    idle.requestCancel();\n    this.#dsh503Relay?.cancel();',
    'stop pending retries on autonomous cancellation');
  source = replace(source,
    '  async #close() {\n    this.#rejectPendingSteers();',
    '  async #close() {\n    await this.#dsh503Relay?.close(); this.#dsh503Relay = null;\n    this.#rejectPendingSteers();',
    'dispose timers sockets and listener on transport unload');
  // settings.json "env" overrides process variables in the CLI; flag settings outrank it.
  source = replace(source,
    '        ...dshUnifiedWakeOptions(this.#environment),\n',
    '        ...dshUnifiedWakeOptions(this.#environment),\n        ...this.#dsh503Relay ? { settings: { env: dshClaudeRelayEnvironment(this.#dsh503Relay, this.#environment) } } : {},\n',
    'route the CLI through the relay even when settings.json names the gateway');
  return source;
}
