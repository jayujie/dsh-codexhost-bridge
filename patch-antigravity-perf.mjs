export function patchAntigravityPerf(source, replace) {
  source = replace(
    source,
    'DEFAULT_INSPECT_TIMEOUT_MS = 2e4',
    'DEFAULT_INSPECT_TIMEOUT_MS = 6e4',
    'allow slow agy models probe on Windows',
  );

  // 0. Context window (516K) + /compact command + canonical model ID for pricing + cache-aware hostUsage + UsageMeter metering.
  source = replace(
    source,
    'var GEMINI_CONTEXT_WINDOW_TOKENS = 1048576;',
    'var GEMINI_CONTEXT_WINDOW_TOKENS = DSH_AGY_GEMINI_CONTEXT_WINDOW_TOKENS;',
    'set Gemini context window to 516K',
  );

  source = replace(
    source,
    `    models.push({
      ref: harnessModelRefSchema.parse({ id }),
      label,
      resolvedModelLabel: label,
      ...ordered.length > 0 ? { supportedThinkingOptionIds: ordered } : {}
    });`,
    `    models.push({
      ref: harnessModelRefSchema.parse({ id }),
      label,
      resolvedModelLabel: id,
      ...ordered.length > 0 ? { supportedThinkingOptionIds: ordered } : {}
    });`,
    'preserve canonical Antigravity model ID in resolvedModelLabel for pricing',
  );

  source = replace(
    source,
    `    {
      id: "antigravity.help",
      invocation: "/help",
      label: "Help",
      description: "Display available Antigravity slash commands and guidance",
      argumentMode: "text"
    }`,
    `    {
      id: "antigravity.compact",
      invocation: "/compact",
      label: "Compact",
      description: "Compact conversation history to free context window",
      argumentMode: "text"
    },
    {
      id: "antigravity.help",
      invocation: "/help",
      label: "Help",
      description: "Display available Antigravity slash commands and guidance",
      argumentMode: "text"
    }`,
    'expose /compact command in Antigravity command catalog',
  );

  source = replace(
    source,
    `function hostUsage(value, modelId, scope) {
  if (!value)
    return null;
  const inputTokens = safeToken(value.input_tokens);
  const outputTokens = safeToken(value.output_tokens);
  const reasoningOutputTokens = safeToken(value.thinking_tokens);
  const totalTokens = safeToken(value.total_tokens);
  const requestPromptTokens = scope === "request" && inputTokens !== void 0 ? inputTokens + (safeToken(value.cache_read_tokens) ?? 0) : void 0;
  const contextUsedTokens = safeToken(value.context_used_tokens ?? value.estimated_tokens_used) ?? requestPromptTokens;
  const rawWindow = safeToken(value.context_window_tokens ?? value.max_context_tokens);
  const contextWindowTokens = contextUsedTokens !== void 0 || rawWindow !== void 0 ? resolveAntigravityContextWindow(modelId, rawWindow) : void 0;
  const usage = {
    ...inputTokens !== void 0 ? { inputTokens } : {},
    ...outputTokens !== void 0 ? { outputTokens } : {},
    ...reasoningOutputTokens !== void 0 ? { reasoningOutputTokens } : {},
    ...totalTokens !== void 0 ? { totalTokens } : {},
    ...contextUsedTokens !== void 0 && contextWindowTokens !== void 0 && contextWindowTokens > 0 ? { contextUsedTokens, contextWindowTokens } : {}
  };
  return Object.keys(usage).length > 0 ? usage : null;
}`,
    `function hostUsage(value, modelId, scope) {
  if (!value)
    return null;
  const uncachedInputTokens = safeToken(value.input_tokens);
  const cachedInputTokens = safeToken(value.cache_read_tokens);
  const cacheWriteInputTokens = safeToken(value.cache_write_tokens ?? value.cache_creation_input_tokens);
  const inputTokens = uncachedInputTokens !== void 0 ? uncachedInputTokens + (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0) : void 0;
  const outputTokens = safeToken(value.output_tokens);
  const rawThinking = safeToken(value.thinking_tokens);
  const reasoningOutputTokens = rawThinking !== void 0 && (outputTokens === void 0 || rawThinking <= outputTokens) ? rawThinking : void 0;
  const totalTokens = inputTokens !== void 0 && outputTokens !== void 0 ? inputTokens + outputTokens : safeToken(value.total_tokens);
  const requestPromptTokens = scope === "request" ? inputTokens : void 0;
  const contextUsedTokens = safeToken(value.context_used_tokens ?? value.estimated_tokens_used) ?? requestPromptTokens;
  const rawWindow = safeToken(value.context_window_tokens ?? value.max_context_tokens);
  const contextWindowTokens = contextUsedTokens !== void 0 || rawWindow !== void 0 ? resolveAntigravityContextWindow(modelId, rawWindow) : void 0;
  const usage = {
    ...inputTokens !== void 0 ? { inputTokens, cachedInputTokens: cachedInputTokens ?? 0, cacheWriteInputTokens: cacheWriteInputTokens ?? 0 } : {},
    ...outputTokens !== void 0 ? { outputTokens } : {},
    ...reasoningOutputTokens !== void 0 ? { reasoningOutputTokens } : {},
    ...totalTokens !== void 0 ? { totalTokens } : {},
    ...contextUsedTokens !== void 0 && contextWindowTokens !== void 0 && contextWindowTokens > 0 ? { contextUsedTokens, contextWindowTokens } : {}
  };
  return Object.keys(usage).length > 0 ? usage : null;
}`,
    'preserve cache_read_tokens and inclusive inputTokens in Antigravity hostUsage',
  );

  source = replace(
    source,
    '  #catalog;\n  constructor(input) {',
    `  #catalog;
  #dshEmittedUsageSteps = /* @__PURE__ */ new Set();
  #dshUsageHistoryEmitted = false;
  #dshLastContextUsed = 0;
  #dshLastContextWindow = GEMINI_CONTEXT_WINDOW_TOKENS;
  #dshCompactedAtUsed = 0;
  #dshCompacting = false;
  #dshCompactAbort = new AbortController();
  constructor(input) {`,
    'track Antigravity transcript usage metering and 516K auto-compaction state',
  );

  source = replace(
    source,
    `    this.commands = {
      list: async () => ({ ok: true, value: ANTIGRAVITY_COMMAND_CATALOG }),
      execute: (command) => this.#executeHarnessCommand(command)
    };
  }`,
    `    this.commands = {
      list: async () => ({ ok: true, value: ANTIGRAVITY_COMMAND_CATALOG }),
      execute: (command) => this.#executeHarnessCommand(command)
    };
    if (this.#nativeRef?.nativeSessionId) {
      void this.#dshSyncTranscriptUsage(this.#nativeRef.nativeSessionId, this.#model?.id, true);
    }
  }`,
    'prime UsageMeter from native transcript on Antigravity session resume',
  );

  source = replace(
    source,
    '  get isActive() {\n    return this.#active !== null || this.#preparingQuestions !== null || [...this.#subagentObservers].some((observer) => observer.running);\n  }',
    '  get isActive() {\n    return this.#dshCompacting || this.#active !== null || this.#preparingQuestions !== null || [...this.#subagentObservers].some((observer) => observer.running);\n  }',
    'treat pre-turn auto-compaction as active session work',
  );

  source = replace(
    source,
    '    const environment = { ...this.#environment, ...questions.environment };',
    `    let didAutoCompact = false;
    if (!text.startsWith("/") && this.#nativeRef?.nativeSessionId && dshShouldAutoCompactAntigravity(this.#dshLastContextUsed, this.#dshLastContextWindow, this.#dshCompactedAtUsed)) {
      didAutoCompact = await this.#dshRunAutoCompact(this.#nativeRef.nativeSessionId);
      if (this.#closed) {
        await questions.dispose();
        return { ok: false, error: invalidState("Antigravity Session is closed") };
      }
    }
    const environment = { ...this.#environment, ...questions.environment };`,
    'trigger /compact automatically at 80% of 516K context window before next turn',
  );

  source = replace(
    source,
    '    this.#event({ type: "turn.started", turnId: command.turnId });\n    return { ok: true, value: { turnId: command.turnId } };',
    `    this.#event({ type: "turn.started", turnId: command.turnId });
    if (didAutoCompact) {
      const compactItem = { type: "contextCompaction", itemId: this.#newItemId() };
      this.#event({ type: "item.started", turnId: command.turnId, item: compactItem });
      this.#completeItem(active, compactItem, { status: "succeeded" });
    }
    return { ok: true, value: { turnId: command.turnId } };`,
    'emit contextCompaction item when 516K auto-compaction runs',
  );

  source = replace(
    source,
    '    this.#closed = true;\n    const preparing = await this.#preparingQuestions?.catch(() => void 0);',
    '    this.#closed = true;\n    this.#dshCompactAbort.abort();\n    const preparing = await this.#preparingQuestions?.catch(() => void 0);',
    'abort in-flight auto-compaction when session closes',
  );

  source = replace(
    source,
    '      this.#history.bindNativeSession(event.conversation_id);\n      this.#event({ type: "session.state.changed", state: this.#state() });\n      this.#ensureContextUsage(active, event.conversation_id);',
    '      this.#history.bindNativeSession(event.conversation_id);\n      this.#event({ type: "session.state.changed", state: this.#state() });\n      if (!this.#dshUsageHistoryEmitted) await this.#dshSyncTranscriptUsage(event.conversation_id, active.model?.id, true);\n      this.#ensureContextUsage(active, event.conversation_id);',
    'initialize UsageMeter history on Antigravity conversation init',
  );

  source = replace(
    source,
    `    if (active.cancellationRequested) {
      this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user", checkpoint }, nativeTurnRef);`,
    `    await this.#dshSyncTranscriptUsage(convId, active.model?.id, false, event.result.usage, safeTurnId, active);
    if (this.#active !== active)
      return;
    if (active.cancellationRequested) {
      this.#completeTurn(active, { status: "cancelled", reason: "Cancelled by user", checkpoint }, nativeTurnRef);`,
    'emit exact transcript usage requests and cache reads before turn completion',
  );

  source = replace(
    source,
    `  #publishUsage(active, usage) {
    active.latestUsage = { ...active.latestUsage ?? {}, ...usage };
    this.#event({
      type: "session.usage.changed",
      usage: active.latestUsage,
      observedForTurnId: active.command.turnId
    });
  }`,
    `  #publishUsage(active, usage) {
    active.latestUsage = { ...active.latestUsage ?? {}, ...usage };
    if (typeof active.latestUsage.contextWindowTokens === "number" && active.latestUsage.contextWindowTokens > 0) {
      this.#dshLastContextWindow = active.latestUsage.contextWindowTokens;
    }
    if (typeof active.latestUsage.contextUsedTokens === "number" && active.latestUsage.contextUsedTokens >= 0) {
      this.#dshLastContextUsed = active.latestUsage.contextUsedTokens;
      if (this.#dshCompactedAtUsed > 0 && this.#dshLastContextUsed < this.#dshCompactedAtUsed * 0.85) {
        this.#dshCompactedAtUsed = 0;
      }
    }
    this.#event({
      type: "session.usage.changed",
      usage: active.latestUsage,
      observedForTurnId: active.command.turnId
    });
  }
  async #dshRunAutoCompact(conversationId) {
    this.#dshCompacting = true;
    this.#dshCompactedAtUsed = this.#dshLastContextUsed;
    try {
      const compactArgs = [
        "--conversation",
        conversationId,
        "--print=/compact",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--add-dir",
        this.#cwd
      ];
      await runBuffered(this.#executable, compactArgs, this.#cwd, this.#environment, 9e4, this.#dshCompactAbort.signal);
      this.#dshLastContextUsed = 0;
      return true;
    } catch {
      return false;
    } finally {
      this.#dshCompacting = false;
    }
  }
  async #dshSyncTranscriptUsage(conversationId, modelId, historical, fallbackResultUsage, fallbackTurnKey, active) {
    if (this.#closed || !conversationId)
      return;
    const { ok, entries } = await dshReadAntigravityTranscriptUsageRequests(this.#environment, conversationId, modelId);
    if (this.#closed)
      return;
    let latestStepPromptTokens;
    for (const entry of entries) {
      latestStepPromptTokens = entry.request.inputTokens;
      if (this.#dshEmittedUsageSteps.has(entry.stepIndex))
        continue;
      this.#dshEmittedUsageSteps.add(entry.stepIndex);
      this.#event({
        type: "usage.request",
        request: historical ? { ...entry.request, historical: true } : entry.request
      });
    }
    if (!ok && !historical && fallbackResultUsage && fallbackTurnKey) {
      const uncached = safeToken(fallbackResultUsage.input_tokens);
      const outputTokens = safeToken(fallbackResultUsage.output_tokens);
      if (uncached !== void 0 && outputTokens !== void 0) {
        const cachedInputTokens = safeToken(fallbackResultUsage.cache_read_tokens) ?? 0;
        const cacheWriteInputTokens = safeToken(fallbackResultUsage.cache_write_tokens ?? fallbackResultUsage.cache_creation_input_tokens) ?? 0;
        const inputTokens = uncached + cachedInputTokens + cacheWriteInputTokens;
        const normalizedModel = modelId ? (dshNormalizeAntigravityModelForPrice(modelId) ?? modelId) : void 0;
        this.#event({
          type: "usage.request",
          request: {
            requestId: \`agy:\${conversationId}:\${fallbackTurnKey}\`,
            ...normalizedModel ? { model: normalizedModel, provider: /^claude(?:[-_.]|$)/iu.test(normalizedModel) ? "anthropic" : "google" } : {},
            inputTokens,
            cachedInputTokens,
            cacheWriteInputTokens,
            outputTokens
          }
        });
      }
    }
    if (!this.#dshUsageHistoryEmitted) {
      this.#dshUsageHistoryEmitted = true;
      this.#event({ type: "usage.history", complete: true });
    }
    if (active && latestStepPromptTokens !== void 0 && active.latestUsage?.contextUsedTokens === void 0) {
      const contextWindowTokens = resolveAntigravityContextWindow(modelId, void 0);
      this.#publishUsage(active, { contextUsedTokens: latestStepPromptTokens, contextWindowTokens });
    }
  }`,
    'sync Antigravity transcript usage into Host UsageMeter and manage 516K auto-compaction',
  );

  // 1. AntigravityHistory: bound file size without changing turns.length/checkpoints,
  //    clone only newly appended turns, coalesce subagent status writes, and
  //    reconstruct turns from native transcript.jsonl on native AGY session import.
  source = replace(
    source,
    `    if (turns.length === 0 && input.knownTurnRefs) {`,
    `    if (turns.length === 0 && nativeSessionId) {
      const imported = await dshReadAntigravityTranscriptTurns(input.environment, nativeSessionId);
      if (imported.turns.length > 0) {
        turns = imported.turns;
        if (!model2 && imported.model) model2 = imported.model;
        if (!thinkingOptionId && imported.thinkingOptionId) thinkingOptionId = imported.thinkingOptionId;
      }
    }
    if (turns.length === 0 && input.knownTurnRefs) {`,
    'reconstruct native Antigravity transcript turns when importing sessions without history json',
  );

  source = replace(
    source,
    '  harnessId = antigravityHarnessId;\n  usageStatistics;',
    `  harnessId = antigravityHarnessId;
  usageStatistics;
  sessionImport = {
    listCandidates: () => this.#closed ? Promise.resolve({ ok: false, error: invalidState("Antigravity Adapter is closed") }) : dshListAntigravityImportCandidates(this.#environment),
    resolveCandidate: (nativeSessionId) => this.#closed ? Promise.resolve({ ok: false, error: invalidState("Antigravity Adapter is closed") }) : dshResolveAntigravityImportCandidate(this.#environment, nativeSessionId)
  };`,
    'expose native Antigravity sessionImport capability on AntigravityAdapter',
  );

  source = replace(
    source,
    '  #write = Promise.resolve();',
    '  #write = Promise.resolve();\n  #writeTimer = null;\n  #writeDirty = false;',
    'track coalesced Antigravity history writes',
  );

  source = replace(
    source,
    '      if (!entry.endsWith(".json"))\n        continue;',
    '      if (!entry.endsWith(".json") || entry.startsWith("."))\n        continue;',
    'ignore temporary dotfiles when scanning Antigravity history',
  );

  source = replace(
    source,
    '          changed = true;\n          return state;',
    '          changed = true;\n          return jsonTurn(state);',
    'clone updated subagent state on mutation only',
  );

  source = replace(
    source,
    '    if (changed)\n      this.#queueWrite();',
    '    if (changed)\n      this.#queueWrite({ debounceMs: 500 });',
    'coalesce frequent subagent history writes',
  );

  source = replace(
    source,
    `    const turn = {
      nativeTurnRef: input.nativeTurnRef,
      ...input.checkpoint ? { checkpoint: input.checkpoint } : {},
      input: input.turnInput,
      items: input.items,
      outcome: input.outcome,
      ...input.model ? { model: input.model } : {}
    };`,
    `    const turn = jsonTurn({
      nativeTurnRef: input.nativeTurnRef,
      ...input.checkpoint ? { checkpoint: input.checkpoint } : {},
      input: input.turnInput,
      items: input.items,
      outcome: input.outcome,
      ...input.model ? { model: input.model } : {}
    });`,
    'clone appended Antigravity turn once instead of deep-cloning all history per write',
  );

  source = replace(
    source,
    `  async flush() {
    await this.#write;
  }
  #queueWrite() {
    if (!this.#file || !this.#nativeSessionId)
      return;
    const file2 = this.#file;
    const nativeSessionId = this.#nativeSessionId;
    const turns = this.#turns.map(jsonTurn);
    const model2 = this.#model;
    const thinkingOptionId = this.#thinkingOptionId;
    this.#write = this.#write.catch(() => void 0).then(async () => {
      const directory = path5.dirname(file2);
      await mkdir(directory, { recursive: true, mode: 448 });
      const temporary = path5.join(directory, \`.\${path5.basename(file2)}.\${randomUUID()}.tmp\`);
      try {
        await writeFile2(temporary, \`\${JSON.stringify({
          formatVersion: HISTORY_VERSION,
          nativeSessionId,
          turns,
          ...model2 ? { model: model2 } : {},
          ...thinkingOptionId ? { thinkingOptionId } : {}
        })}
\`, { mode: 384 });
        await rename(temporary, file2);
      } finally {
        await rm2(temporary, { force: true }).catch(() => void 0);
      }
    });
  }`,
    `  async flush() {
    if (this.#writeTimer !== null) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    if (this.#writeDirty) {
      this.#writeDirty = false;
      this.#enqueueWriteNow();
    }
    await this.#write;
  }
  #queueWrite(options = {}) {
    if (!this.#file || !this.#nativeSessionId)
      return;
    const debounceMs = options.debounceMs ?? 0;
    if (debounceMs > 0) {
      this.#writeDirty = true;
      if (this.#writeTimer === null) {
        this.#writeTimer = setTimeout(() => {
          this.#writeTimer = null;
          if (this.#writeDirty) {
            this.#writeDirty = false;
            this.#enqueueWriteNow();
          }
        }, debounceMs);
        this.#writeTimer.unref?.();
      }
      return;
    }
    if (this.#writeTimer !== null) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
    }
    this.#writeDirty = false;
    this.#enqueueWriteNow();
  }
  #enqueueWriteNow() {
    if (!this.#file || !this.#nativeSessionId)
      return;
    this.#turns = dshCompactAntigravityTurns(this.#turns);
    const file2 = this.#file;
    const payload = \`\${JSON.stringify({
      formatVersion: HISTORY_VERSION,
      nativeSessionId: this.#nativeSessionId,
      turns: this.#turns,
      ...this.#model ? { model: this.#model } : {},
      ...this.#thinkingOptionId ? { thinkingOptionId: this.#thinkingOptionId } : {}
    })}
\`;
    this.#write = this.#write.catch(() => void 0).then(async () => {
      const directory = path5.dirname(file2);
      await mkdir(directory, { recursive: true, mode: 448 });
      const temporary = path5.join(directory, \`.\${path5.basename(file2)}.\${randomUUID()}.tmp\`);
      try {
        await writeFile2(temporary, payload, { mode: 384 });
        await rename(temporary, file2);
      } finally {
        await rm2(temporary, { force: true }).catch(() => void 0);
      }
    });
  }`,
    'compact older Antigravity history payloads and coalesce writes',
  );

  // 2. GetCascadeTrajectorySteps: bounded response, terminal-only fetch, per-turn cache & circuit breaker.
  source = replace(
    source,
    `function requestAntigravityTrajectorySteps(port, conversationId, timeoutMs) {
  return new Promise((resolve) => {
    const request = https.request({
      hostname: "127.0.0.1",
      port,
      path: "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps",
      method: "POST",
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: { "content-type": "application/json" }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200)
          return resolve([]);
        try {
          resolve(parseAntigravityCodeActions(JSON.parse(body)));
        } catch {
          resolve([]);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve([]));
    request.end(JSON.stringify({ cascadeId: conversationId }));
  });
}`,
    `function requestAntigravityTrajectorySteps(port, conversationId, timeoutMs) {
  return dshRequestAntigravityTrajectorySteps(port, conversationId, timeoutMs, parseAntigravityCodeActions).then((result) => result.actions);
}`,
    'bound GetCascadeTrajectorySteps response size with Buffer chunking',
  );

  source = replace(
    source,
    '      codeActionCursor: 0,\n      fileChanges: /* @__PURE__ */ new Map(),',
    '      codeActionCursor: 0,\n      cachedCodeActions: null,\n      trajectoryTimeouts: 0,\n      trajectoryDegraded: false,\n      fileChanges: /* @__PURE__ */ new Map(),',
    'track per-turn trajectory cache and degradation circuit breaker',
  );

  source = replace(
    source,
    `  async #startToolItem(active, step) {
    const toolName = step.tool_name ?? step.tool_info?.name ?? "antigravity.tool";
    if (isAntigravityFileMutatingTool(toolName)) {
      const change = await this.#claimFileChange(active, step, toolName);
      if (change) {
        return { type: "fileChange", itemId: this.#newItemId(), changes: [change] };
      }
      if (step.state !== "DONE" && step.state !== "ERROR")
        return null;
    }
    return startAntigravityToolItem(this.#newItemId(), step, this.#cwd);
  }
  async #claimFileChange(active, step, toolName) {
    const claimed = active.fileChanges.get(step.step_index);
    if (claimed)
      return claimed;
    const target = toolTargetFile(toolName, step.tool_info?.parameters);
    if (!target)
      return null;
    const port = await this.#languageServerPort(active);
    if (port === null)
      return null;
    const actions = await requestAntigravityTrajectorySteps(port, step.conversation_id, TRAJECTORY_TIMEOUT_MS);
    const index = actions.findIndex((action2, at) => at >= active.codeActionCursor && sameFile(action2.absolutePath, target));
    const action = index === -1 ? void 0 : actions[index];
    if (!action)
      return null;
    const change = codeActionFileChange(action, this.#cwd);
    if (!change)
      return null;
    active.codeActionCursor = index + 1;
    active.fileChanges.set(step.step_index, change);
    return change;
  }`,
    `  async #startToolItem(active, step) {
    const toolName = step.tool_name ?? step.tool_info?.name ?? "antigravity.tool";
    if (isAntigravityFileMutatingTool(toolName)) {
      if (step.state !== "DONE" && step.state !== "ERROR")
        return null;
      if (step.state === "DONE") {
        const change = await this.#claimFileChange(active, step, toolName);
        if (change) {
          return { type: "fileChange", itemId: this.#newItemId(), changes: [change] };
        }
      }
    }
    return startAntigravityToolItem(this.#newItemId(), step, this.#cwd);
  }
  async #claimFileChange(active, step, toolName) {
    const claimed = active.fileChanges.get(step.step_index);
    if (claimed)
      return claimed;
    if (active.trajectoryDegraded)
      return null;
    const target = toolTargetFile(toolName, step.tool_info?.parameters);
    if (!target)
      return null;
    let actions = active.cachedCodeActions;
    let index = Array.isArray(actions) ? actions.findIndex((action2, at) => at >= active.codeActionCursor && sameFile(action2.absolutePath, target)) : -1;
    if (index === -1) {
      const port = await this.#languageServerPort(active);
      if (port === null)
        return null;
      const fetched = await dshRequestAntigravityTrajectorySteps(port, step.conversation_id, TRAJECTORY_TIMEOUT_MS, parseAntigravityCodeActions);
      if (!fetched.ok) {
        if (fetched.reason === "oversize") {
          active.trajectoryDegraded = true;
        } else if (fetched.reason === "timeout") {
          active.trajectoryTimeouts += 1;
          if (active.trajectoryTimeouts >= 2)
            active.trajectoryDegraded = true;
        }
        return null;
      }
      active.trajectoryTimeouts = 0;
      actions = fetched.actions;
      active.cachedCodeActions = actions;
      index = actions.findIndex((action2, at) => at >= active.codeActionCursor && sameFile(action2.absolutePath, target));
    }
    const action = index === -1 ? void 0 : actions[index];
    if (!action)
      return null;
    const change = codeActionFileChange(action, this.#cwd);
    if (!change)
      return null;
    active.codeActionCursor = index + 1;
    active.fileChanges.set(step.step_index, change);
    return change;
  }`,
    'fetch trajectory diffs only on DONE with cache reuse and degradation breaker',
  );

  // 3. AntigravityAdapter.inspect: global cache key + disk cache + background SWR refresh.
  source = replace(
    source,
    '  #quotaAbort = new AbortController();',
    '  #quotaAbort = new AbortController();\n  #dshRefreshAbort = new AbortController();\n  #dshBgRefreshStarted = false;\n  #dshBgRefresh = null;',
    'track background Antigravity catalog refresh abort controller',
  );

  source = replace(
    source,
    `  async inspect(input = {}) {
    if (this.#closed) {
      return { status: "unavailable", error: invalidState("Antigravity Adapter is closed") };
    }
    const cwd = path11.resolve(input.cwd ?? process.cwd());
    const inFlight = this.#inspectionInFlight.get(cwd);
    if (inFlight)
      return inFlight;
    if (!input.refresh) {
      const cached2 = this.#inspectionCache.get(cwd);
      if (cached2)
        return cached2;
    }
    const inspection = this.#inspectCwd(cwd).then((result) => {
      if (result.status === "ready") {
        this.#inspectionCache.set(cwd, result);
        this.#quotaCwd = cwd;
        void this.refreshCredits().catch(() => void 0);
      }
      return result;
    });
    this.#inspectionInFlight.set(cwd, inspection);
    return inspection.finally(() => {
      if (this.#inspectionInFlight.get(cwd) === inspection) {
        this.#inspectionInFlight.delete(cwd);
      }
    });
  }
  async #inspectCwd(cwd) {
    const executable = resolveAntigravityExecutable({
      ...this.#command ? { command: this.#command } : {},
      environment: this.#environment
    });
    if (!executable) {
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Antigravity CLI (agy) is not installed",
          retryable: false
        }
      };
    }
    try {
      const { stdout } = await runBuffered(executable, ["models"], cwd, this.#environment, this.#inspectTimeoutMs);
      return {
        status: "ready",
        catalog: parseAntigravityModels(stdout),
        permissionModes: ANTIGRAVITY_PERMISSION_MODE_CATALOG,
        capabilities: CAPABILITIES
      };
    } catch (error51) {
      const message = errorMessage(error51);
      const normalized = normalizedProcessError(message, message);
      return {
        status: "error",
        error: { ...normalized, stage: "model-catalog" }
      };
    }
  }`,
    `  async inspect(input = {}) {
    if (this.#closed) {
      return { status: "unavailable", error: invalidState("Antigravity Adapter is closed") };
    }
    const cwd = path11.resolve(input.cwd ?? process.cwd());
    const executable = resolveAntigravityExecutable({
      ...this.#command ? { command: this.#command } : {},
      environment: this.#environment
    });
    if (!executable) {
      this.#inspectionCache.clear();
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Antigravity CLI (agy) is not installed",
          retryable: false
        }
      };
    }
    const cacheKey = "*";
    if (!input.refresh) {
      const cached2 = this.#inspectionCache.get(cacheKey);
      if (cached2)
        return cached2;
      const disk = dshReadAntigravityCatalogCache(this.#environment, executable, harnessModelCatalogSchema);
      if (disk) {
        const result = {
          status: "ready",
          catalog: disk.catalog,
          permissionModes: ANTIGRAVITY_PERMISSION_MODE_CATALOG,
          capabilities: CAPABILITIES
        };
        this.#inspectionCache.set(cacheKey, result);
        this.#quotaCwd = cwd;
        this.#dshStartBackgroundRefresh(cwd, executable);
        return result;
      }
    }
    const inFlight = this.#inspectionInFlight.get(cacheKey);
    if (inFlight)
      return inFlight;
    const inspection = this.#inspectCwd(cwd, executable).then(async (result) => {
      if (!this.#closed && result.status === "ready") {
        this.#inspectionCache.set(cacheKey, result);
        this.#quotaCwd = cwd;
        await dshWriteAntigravityCatalogCache(this.#environment, executable, result.catalog);
        void this.refreshCredits().catch(() => void 0);
      }
      return result;
    });
    this.#inspectionInFlight.set(cacheKey, inspection);
    return inspection.finally(() => {
      if (this.#inspectionInFlight.get(cacheKey) === inspection) {
        this.#inspectionInFlight.delete(cacheKey);
      }
    });
  }
  #dshStartBackgroundRefresh(cwd, executable) {
    if (this.#closed || this.#dshBgRefreshStarted)
      return;
    this.#dshBgRefreshStarted = true;
    this.#dshBgRefresh = this.#inspectCwd(cwd, executable, this.#dshRefreshAbort.signal).then(async (result) => {
      if (!this.#closed && result.status === "ready") {
        this.#inspectionCache.set("*", result);
        await dshWriteAntigravityCatalogCache(this.#environment, executable, result.catalog);
        void this.refreshCredits().catch(() => void 0);
      }
    }).catch(() => void 0).finally(() => {
      this.#dshBgRefresh = null;
    });
  }
  async #inspectCwd(cwd, resolvedExecutable, signal) {
    const executable = resolvedExecutable ?? resolveAntigravityExecutable({
      ...this.#command ? { command: this.#command } : {},
      environment: this.#environment
    });
    if (!executable) {
      return {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: "Antigravity CLI (agy) is not installed",
          retryable: false
        }
      };
    }
    try {
      const { stdout } = await runBuffered(executable, ["models"], cwd, this.#environment, this.#inspectTimeoutMs, signal);
      return {
        status: "ready",
        catalog: parseAntigravityModels(stdout),
        permissionModes: ANTIGRAVITY_PERMISSION_MODE_CATALOG,
        capabilities: CAPABILITIES
      };
    } catch (error51) {
      const message = errorMessage(error51);
      const normalized = normalizedProcessError(message, message);
      return {
        status: "error",
        error: { ...normalized, stage: "model-catalog" }
      };
    }
  }`,
    'share global Antigravity model catalog with disk cache and background refresh',
  );

  source = replace(
    source,
    '    const cwd = path11.resolve(input.cwd);\n    let catalog = this.#inspectionCache.get(cwd)?.catalog;',
    '    let catalog = this.#inspectionCache.get("*")?.catalog;',
    'read global Antigravity catalog cache on session open',
  );

  source = replace(
    source,
    '    this.#quotaAbort.abort();\n    await Promise.all([...this.#sessions].map((session) => session.close()));',
    '    this.#quotaAbort.abort();\n    this.#dshRefreshAbort.abort();\n    await Promise.all([...this.#sessions].map((session) => session.close()));\n    await Promise.allSettled([this.#dshBgRefresh, this.#quotaRefresh].filter(Boolean));',
    'abort and settle background Antigravity refreshes on adapter close',
  );

  return source;
}
